import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AcceptNormalizedEventInput,
  AcceptedNormalizedEvent,
  AppendLineEventInput,
  BranchContext,
  BranchMerge,
  BranchResult,
  BranchResultTrace,
  BranchStatus,
  ConversationBranch,
  ConversationContextSnapshot,
  ConversationLine,
  ConversationLineHead,
  ConversationMainline,
  ConversationNode,
  ConversationRecoveryState,
  ConversationSession,
  ConversationTask,
  CreateBranchInput,
  CreateBranchResultInput,
  CreateConversationContextSnapshotInput,
  CreateConversationNodeInput,
  CreateSessionInput,
  CreateTaskInput,
  EventTrace,
  LineEvent,
  ListBranchesOptions,
  ListConversationNodesOptions,
  ListLineEventsOptions,
  ListLinesOptions,
  ListTasksOptions,
  MergeBranchResultInput,
  NormalizedEvent,
  PublishBranchResultInput,
  ReconstructedConversationState,
  TaskTrace,
  TransitionBranchInput,
  TransitionSessionInput,
  TransitionTaskInput
} from "./types.js";
import type { ConversationStore } from "./store.js";
import { ConversationStoreError } from "./errors.js";
import { collectRelatedEvents } from "./trace.js";
import { applyConversationStatePatch } from "./state.js";
import {
  ACTIVE_BRANCH_STATUSES,
  assertBranchCanCreateResult,
  assertBranchCanCreateTask,
  assertWritableSession,
  BRANCH_STATUSES_REQUIRING_TERMINAL_TASKS,
  invalidTransition,
  isBranchTransitionAllowed,
  isSessionTransitionAllowed,
  isTaskTransitionAllowed,
  isTerminalTaskStatus,
  payloadContainsTaskId,
  SESSION_ARCHIVABLE_BRANCH_STATUSES,
  UNFINISHED_TASK_STATUSES
} from "./rules.js";
import {
  sessionIdFromInput,
  validateAcceptNormalizedEventInput,
  validateAppendLineEventInput,
  validateCreateBranchInput,
  validateCreateBranchResultInput,
  validateCreateConversationNodeInput,
  validateCreateSessionInput,
  validateCreateTaskInput,
  validateIdempotencyKey,
  validateListConversationNodesOptions,
  validateListOptions,
  validateNonEmpty
} from "./in-memory-validation.js";

interface IdempotentRecord<T> {
  readonly signature: unknown;
  readonly value: T;
}

/**
 * 追加式会话模型的内存参考实现
 *
 * 所有跨越存储边界的值都会执行结构化克隆以避免调用方修改已追加对象
 */
export class InMemoryConversationStore implements ConversationStore {
  readonly #sessions = new Map<string, ConversationSession>();
  readonly #lines = new Map<string, ConversationLine>();
  readonly #events = new Map<string, LineEvent>();
  readonly #eventIdsByLine = new Map<string, string[]>();
  readonly #normalizedEvents = new Map<string, NormalizedEvent>();
  readonly #normalizedEventIdsBySession = new Map<string, string[]>();
  readonly #tasks = new Map<string, ConversationTask>();
  readonly #taskIdsByBranch = new Map<string, string[]>();
  readonly #results = new Map<string, BranchResult>();
  readonly #resultIdsByBranch = new Map<string, string[]>();
  readonly #resultEventIds = new Map<string, string>();
  readonly #merges = new Map<string, BranchMerge>();
  readonly #mergesByResult = new Map<string, BranchMerge>();
  readonly #nodes = new Map<string, ConversationNode>();
  readonly #nodeIdsByLine = new Map<string, string[]>();
  readonly #lineHeads = new Map<string, ConversationLineHead>();
  readonly #snapshots = new Map<string, ConversationContextSnapshot>();
  readonly #snapshotIdsByLine = new Map<string, string[]>();

  readonly #sessionCreateOps = new Map<string, IdempotentRecord<ConversationSession>>();
  readonly #sessionCreateSignatures = new Map<string, unknown>();
  readonly #sessionTransitionOps = new Map<string, IdempotentRecord<ConversationSession>>();
  readonly #normalizedAcceptOps = new Map<string, IdempotentRecord<AcceptedNormalizedEvent>>();
  readonly #normalizedSourceIndex = new Map<string, string>();
  readonly #branchCreateOps = new Map<string, IdempotentRecord<ConversationBranch>>();
  readonly #branchTransitionOps = new Map<string, IdempotentRecord<ConversationBranch>>();
  readonly #eventAppendOps = new Map<string, IdempotentRecord<LineEvent>>();
  readonly #taskCreateOps = new Map<string, IdempotentRecord<ConversationTask>>();
  readonly #taskTransitionOps = new Map<string, IdempotentRecord<ConversationTask>>();
  readonly #resultCreateOps = new Map<string, IdempotentRecord<BranchResult>>();
  readonly #mergeOps = new Map<string, IdempotentRecord<BranchMerge>>();
  readonly #nodeCreateOps = new Map<string, IdempotentRecord<ConversationNode>>();
  readonly #snapshotCreateOps = new Map<string, IdempotentRecord<ConversationContextSnapshot>>();

  #nextOrdinal = 1;
  #nextNodeOrdinal = 1;

  async acceptNormalizedEvent(input: AcceptNormalizedEventInput): Promise<AcceptedNormalizedEvent> {
    validateAcceptNormalizedEventInput(input);
    const safeInput = cloneValue(input);
    const signature = normalizedAcceptSignature(safeInput);
    const operationKey = normalizedOperationKey(safeInput);
    const existingOperation = this.#normalizedAcceptOps.get(operationKey);

    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "normalized event", safeInput.idempotencyKey);
      return cloneValue({ ...existingOperation.value, created: false });
    }

    const sourceKey = normalizedSourceKey(safeInput);
    const existingSourceId = this.#normalizedSourceIndex.get(sourceKey);
    if (existingSourceId !== undefined) {
      const existingEvent = required(this.#normalizedEvents, existingSourceId, "normalized event");
      const existingLineEvent = required(this.#events, existingEvent.lineEventId, "line event");
      const existingSession = required(this.#sessions, existingEvent.sessionId, "session");
      const existingMainline = this.#requiredMainline(existingSession);
      const existingSignature = normalizedEventSignature(existingEvent);
      assertSameRequest(
        existingSignature,
        normalizedEntitySignatureFromInput(safeInput, existingEvent.lineId),
        "normalized source event",
        sourceKey
      );
      const duplicate: AcceptedNormalizedEvent = {
        event: existingEvent,
        lineEvent: existingLineEvent,
        session: existingSession,
        mainline: existingMainline,
        created: false
      };
      this.#normalizedAcceptOps.set(operationKey, { signature, value: cloneValue(duplicate) });
      return cloneValue(duplicate);
    }

    const normalizedId = safeInput.id ?? `normalized-${randomUUID()}`;
    if (this.#normalizedEvents.has(normalizedId)) {
      throw conflict(`Normalized event "${normalizedId}" already exists.`);
    }
    const lineEventId = safeInput.lineEventId ?? `event-${randomUUID()}`;
    if (this.#events.has(lineEventId)) {
      throw conflict(`Line event "${lineEventId}" already exists.`);
    }

    const existingSession = this.#sessions.get(safeInput.sessionId);
    if (safeInput.targetLineId !== undefined && existingSession === undefined) {
      throw notFound("session", safeInput.sessionId);
    }

    const ensured = this.#ensureSessionInternal({
      id: safeInput.sessionId,
      locator: {
        platform: safeInput.platform,
        provider: safeInput.provider,
        channelId: safeInput.channelId,
        conversationType: safeInput.conversationType,
        conversationId: safeInput.conversationId
      },
      ...(safeInput.workspaceId === undefined ? {} : { workspaceId: safeInput.workspaceId }),
      ...(safeInput.sessionMetadata === undefined ? {} : { metadata: safeInput.sessionMetadata }),
      createdAt: safeInput.receivedAt
    });
    const session = ensured.session;
    this.#assertSessionLocator(session, safeInput);
    const mainline = this.#requiredMainline(session);
    const targetLine = safeInput.targetLineId === undefined ? mainline : this.#requiredLine(safeInput.targetLineId);
    assertLineSession(targetLine, session.id);
    if (targetLine.status === "archived") {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Cannot accept a normalized event into archived line "${targetLine.id}".`
      );
    }
    if (this.#eventAppendOps.has(scopedKey(targetLine.id, `normalized:${safeInput.idempotencyKey}`))) {
      throw conflict(
        `Line "${targetLine.id}" already contains an event for normalized idempotency key "${safeInput.idempotencyKey}".`
      );
    }

    const acceptedAt = new Date().toISOString();
    const lineEventInput: AppendLineEventInput = {
      id: lineEventId,
      sessionId: session.id,
      type: safeInput.lineEventType ?? "user_message",
      idempotencyKey: `normalized:${safeInput.idempotencyKey}`,
      sourceNormalizedEventId: normalizedId,
      ...(safeInput.actorId === undefined ? {} : { actorId: safeInput.actorId }),
      payload: {
        normalizedEventId: normalizedId,
        text: safeInput.text,
        ...(safeInput.message === undefined ? {} : { message: safeInput.message }),
        segments: safeInput.segments ?? safeInput.message?.segments ?? [],
        ...(safeInput.triggerHint === undefined ? {} : { triggerHint: safeInput.triggerHint })
      },
      createdAt: safeInput.receivedAt
    };

    const normalized: NormalizedEvent = {
      id: normalizedId,
      sessionId: session.id,
      lineId: targetLine.id,
      lineEventId,
      platform: safeInput.platform,
      provider: safeInput.provider,
      channelId: safeInput.channelId,
      conversationType: safeInput.conversationType,
      conversationId: safeInput.conversationId,
      sourceEventId: safeInput.sourceEventId,
      ...(safeInput.sourceMessageId === undefined ? {} : { sourceMessageId: safeInput.sourceMessageId }),
      sourceEventType: safeInput.sourceEventType,
      senderId: safeInput.senderId,
      text: safeInput.text,
      ...(safeInput.message === undefined ? {} : { message: safeInput.message }),
      segments: safeInput.segments ?? safeInput.message?.segments ?? [],
      ...(safeInput.triggerHint === undefined ? {} : { triggerHint: safeInput.triggerHint }),
      ...(safeInput.rawPayload === undefined ? {} : { rawPayload: safeInput.rawPayload }),
      receivedAt: safeInput.receivedAt,
      idempotencyKey: safeInput.idempotencyKey,
      acceptedAt
    };

    // Make the normalized source visible while the linked line event is
    // appended so source ownership can be validated by the common path.
    this.#normalizedEvents.set(normalized.id, cloneValue(normalized));
    appendIndex(this.#normalizedEventIdsBySession, session.id, normalized.id);
    this.#normalizedSourceIndex.set(sourceKey, normalized.id);

    const lineEvent = this.#appendEventInternal(targetLine.id, lineEventInput);
    const accepted: AcceptedNormalizedEvent = {
      event: normalized,
      lineEvent,
      session,
      mainline,
      created: true
    };
    this.#normalizedAcceptOps.set(operationKey, { signature, value: cloneValue(accepted) });
    return cloneValue(accepted);
  }

  async getNormalizedEvent(eventId: string): Promise<NormalizedEvent | undefined> {
    return cloneOptional(this.#normalizedEvents.get(eventId));
  }

  async listNormalizedEvents(sessionId: string): Promise<readonly NormalizedEvent[]> {
    this.#requiredSession(sessionId);
    return cloneValue(
      (this.#normalizedEventIdsBySession.get(sessionId) ?? []).map((eventId) =>
        required(this.#normalizedEvents, eventId, "normalized event")
      )
    );
  }

  async createSession(input: CreateSessionInput): Promise<ConversationSession> {
    return this.#createSession(input);
  }

  async ensureSession(input: CreateSessionInput): Promise<ConversationSession> {
    return cloneValue(this.#ensureSessionInternal(input).session);
  }

  async getSession(sessionId: string): Promise<ConversationSession | undefined> {
    return cloneOptional(this.#sessions.get(sessionId));
  }

  async transitionSession(sessionId: string, input: TransitionSessionInput): Promise<ConversationSession> {
    validateIdempotencyKey(input.idempotencyKey);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(sessionId, safeInput.idempotencyKey);
    const existingOperation = this.#sessionTransitionOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "session transition", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const session = this.#requiredSession(sessionId);
    if (!isSessionTransitionAllowed(session.status, safeInput.status)) {
      throw invalidTransition("session", session.id, session.status, safeInput.status);
    }
    this.#assertSessionCanArchive(session.id);

    const at = safeInput.createdAt ?? new Date().toISOString();
    const mainline = this.#requiredMainline(session);
    this.#appendEventInternal(mainline.id, {
      type: "session_status_changed",
      idempotencyKey: `internal:session-status:${safeInput.idempotencyKey}`,
      payload: { fromStatus: session.status, toStatus: safeInput.status },
      createdAt: at
    });

    const nextSession: ConversationSession = { ...session, status: safeInput.status, updatedAt: at };
    const nextMainline: ConversationMainline = { ...mainline, status: safeInput.status, updatedAt: at };
    this.#sessions.set(session.id, cloneValue(nextSession));
    this.#lines.set(mainline.id, cloneValue(nextMainline));
    this.#sessionTransitionOps.set(operationKey, {
      signature,
      value: cloneValue(nextSession)
    });
    return cloneValue(nextSession);
  }

  async getLine(lineId: string): Promise<ConversationLine | undefined> {
    return cloneOptional(this.#lines.get(lineId));
  }

  async getMainline(sessionId: string): Promise<ConversationMainline> {
    return cloneValue(this.#requiredMainline(this.#requiredSession(sessionId)));
  }

  async listLines(sessionId: string, options: ListLinesOptions = {}): Promise<readonly ConversationLine[]> {
    this.#requiredSession(sessionId);
    const statuses = options.statuses === undefined ? undefined : new Set(options.statuses);
    return cloneValue(
      [...this.#lines.values()].filter(
        (line) =>
          line.sessionId === sessionId &&
          (options.kind === undefined || line.kind === options.kind) &&
          (statuses === undefined || statuses.has(line.status))
      )
    );
  }

  async createBranch(input: CreateBranchInput): Promise<ConversationBranch> {
    validateCreateBranchInput(input);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(safeInput.sessionId, safeInput.idempotencyKey);
    const existingOperation = this.#branchCreateOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "branch creation", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const session = this.#requiredSession(safeInput.sessionId);
    assertWritableSession(session);
    const mainline = this.#requiredMainline(session);
    const parentMainline =
      safeInput.parentMainlineId === undefined ? mainline : this.#requiredMainlineById(safeInput.parentMainlineId);
    assertLineSession(parentMainline, session.id);
    if (parentMainline.id !== mainline.id) {
      throw ownershipMismatch(
        `Mainline "${parentMainline.id}" is not the default mainline for session "${session.id}".`
      );
    }

    const sourceEvent = this.#requiredEvent(safeInput.sourceEventId);
    if (sourceEvent.sessionId !== session.id || sourceEvent.lineId !== parentMainline.id) {
      throw ownershipMismatch(
        `Source event "${sourceEvent.id}" must belong to mainline "${parentMainline.id}" in session "${session.id}".`
      );
    }

    const branchId = safeInput.id ?? `branch-${randomUUID()}`;
    if (this.#lines.has(branchId)) {
      throw conflict(`Conversation line "${branchId}" already exists.`);
    }

    const now = safeInput.createdAt ?? new Date().toISOString();
    const branch: ConversationBranch = {
      id: branchId,
      sessionId: session.id,
      kind: "branch",
      parentMainlineId: parentMainline.id,
      sourceEventId: sourceEvent.id,
      title: safeInput.title,
      goal: safeInput.goal,
      reason: safeInput.reason,
      status: "created",
      createdBy: safeInput.createdBy,
      idempotencyKey: safeInput.idempotencyKey,
      ...(safeInput.contextSnapshot === undefined ? {} : { contextSnapshot: safeInput.contextSnapshot }),
      createdAt: now,
      updatedAt: now
    };
    this.#lines.set(branch.id, cloneValue(branch));
    this.#eventIdsByLine.set(branch.id, []);
    this.#taskIdsByBranch.set(branch.id, []);
    this.#resultIdsByBranch.set(branch.id, []);
    this.#appendEventInternal(branch.id, {
      type: "branch_created",
      idempotencyKey: `internal:branch-created:${branch.id}`,
      sourceEventId: sourceEvent.id,
      correlationId: branch.id,
      payload: {
        branchId: branch.id,
        title: branch.title,
        goal: branch.goal,
        reason: branch.reason,
        createdBy: branch.createdBy,
        ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot })
      },
      createdAt: now
    });
    this.#branchCreateOps.set(operationKey, { signature, value: cloneValue(branch) });
    return cloneValue(branch);
  }

  async getBranch(branchId: string): Promise<ConversationBranch | undefined> {
    const line = this.#lines.get(branchId);
    return line?.kind === "branch" ? cloneValue(line) : undefined;
  }

  async listBranches(sessionId: string, options: ListBranchesOptions = {}): Promise<readonly ConversationBranch[]> {
    this.#requiredSession(sessionId);
    const statuses = options.statuses === undefined ? undefined : new Set(options.statuses);
    return cloneValue(
      [...this.#lines.values()].filter(
        (line): line is ConversationBranch =>
          line.kind === "branch" &&
          line.sessionId === sessionId &&
          (statuses === undefined || statuses.has(line.status))
      )
    );
  }

  async transitionBranch(branchId: string, input: TransitionBranchInput): Promise<ConversationBranch> {
    validateIdempotencyKey(input.idempotencyKey);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(branchId, safeInput.idempotencyKey);
    const existingOperation = this.#branchTransitionOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "branch transition", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const branch = this.#requiredBranch(branchId);
    if (safeInput.status === "merged") {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Branch "${branch.id}" can enter "merged" only through mergeBranchResult().`
      );
    }
    if (!isBranchTransitionAllowed(branch.status, safeInput.status)) {
      throw invalidTransition("branch", branch.id, branch.status, safeInput.status);
    }
    if (BRANCH_STATUSES_REQUIRING_TERMINAL_TASKS.has(safeInput.status)) {
      this.#assertBranchTasksTerminal(branch.id, `transition to "${safeInput.status}"`);
    }

    const at = safeInput.createdAt ?? new Date().toISOString();
    const causationEventId = last(this.#eventIdsByLine.get(branch.id));
    this.#appendEventInternal(branch.id, {
      type: "branch_status_changed",
      idempotencyKey: `internal:branch-status:${safeInput.idempotencyKey}`,
      ...(causationEventId === undefined ? {} : { causationEventId }),
      correlationId: branch.id,
      payload: {
        fromStatus: branch.status,
        toStatus: safeInput.status,
        ...(safeInput.payload === undefined ? {} : { detail: safeInput.payload })
      },
      createdAt: at
    });

    const next = branchWithStatus(branch, safeInput.status, at);
    this.#lines.set(branch.id, cloneValue(next));
    this.#branchTransitionOps.set(operationKey, { signature, value: cloneValue(next) });
    return cloneValue(next);
  }

  async appendEvent(lineId: string, input: AppendLineEventInput): Promise<LineEvent> {
    return cloneValue(this.#appendEventInternal(lineId, input));
  }

  async getEvent(eventId: string): Promise<LineEvent | undefined> {
    return cloneOptional(this.#events.get(eventId));
  }

  async listEvents(lineId: string, options: ListLineEventsOptions = {}): Promise<readonly LineEvent[]> {
    this.#requiredLine(lineId);
    validateListOptions(options);
    const types = options.types === undefined ? undefined : new Set(options.types);
    let events = (this.#eventIdsByLine.get(lineId) ?? [])
      .map((eventId) => required(this.#events, eventId, "line event"))
      .filter(
        (event) =>
          (options.afterSequence === undefined || event.sequence > options.afterSequence) &&
          (options.beforeSequence === undefined || event.sequence < options.beforeSequence) &&
          (types === undefined || types.has(event.type))
      );
    if (options.limit !== undefined) {
      events = events.slice(-options.limit);
    }
    return cloneValue(events);
  }

  async createTask(branchId: string, input: CreateTaskInput): Promise<ConversationTask> {
    validateCreateTaskInput(input);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(branchId, safeInput.idempotencyKey);
    const existingOperation = this.#taskCreateOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "task creation", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const branch = this.#requiredBranch(branchId);
    assertBranchCanCreateTask(branch);
    if (safeInput.sourceEventId !== undefined) {
      const sourceEvent = this.#requiredEvent(safeInput.sourceEventId);
      if (sourceEvent.sessionId !== branch.sessionId || sourceEvent.lineId !== branch.id) {
        throw ownershipMismatch(`Task source event "${sourceEvent.id}" must belong to branch "${branch.id}".`);
      }
    }

    const taskId = safeInput.id ?? `task-${randomUUID()}`;
    if (this.#tasks.has(taskId)) {
      throw conflict(`Task "${taskId}" already exists.`);
    }

    const now = safeInput.createdAt ?? new Date().toISOString();
    const task: ConversationTask = {
      id: taskId,
      sessionId: branch.sessionId,
      branchId: branch.id,
      status: "pending",
      executor: safeInput.executor,
      ...(safeInput.workspaceId === undefined ? {} : { workspaceId: safeInput.workspaceId }),
      input: safeInput.input,
      artifacts: safeInput.artifacts ?? [],
      idempotencyKey: safeInput.idempotencyKey,
      ...(safeInput.sourceEventId === undefined ? {} : { sourceEventId: safeInput.sourceEventId }),
      createdAt: now,
      updatedAt: now
    };
    this.#tasks.set(task.id, cloneValue(task));
    appendIndex(this.#taskIdsByBranch, branch.id, task.id);
    const causationEventId = safeInput.sourceEventId ?? last(this.#eventIdsByLine.get(branch.id));
    this.#appendEventInternal(branch.id, {
      type: "task_created",
      idempotencyKey: `internal:task-created:${task.id}`,
      ...(safeInput.sourceEventId === undefined ? {} : { sourceEventId: safeInput.sourceEventId }),
      ...(causationEventId === undefined ? {} : { causationEventId }),
      correlationId: branch.id,
      taskId: task.id,
      payload: {
        taskId: task.id,
        executor: task.executor,
        ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
        input: task.input,
        artifacts: task.artifacts
      },
      createdAt: now
    });
    this.#taskCreateOps.set(operationKey, { signature, value: cloneValue(task) });
    return cloneValue(task);
  }

  async getTask(taskId: string): Promise<ConversationTask | undefined> {
    return cloneOptional(this.#tasks.get(taskId));
  }

  async listTasks(branchId: string, options: ListTasksOptions = {}): Promise<readonly ConversationTask[]> {
    this.#requiredBranch(branchId);
    const statuses = options.statuses === undefined ? undefined : new Set(options.statuses);
    return cloneValue(
      (this.#taskIdsByBranch.get(branchId) ?? [])
        .map((taskId) => required(this.#tasks, taskId, "task"))
        .filter((task) => statuses === undefined || statuses.has(task.status))
    );
  }

  async transitionTask(taskId: string, input: TransitionTaskInput): Promise<ConversationTask> {
    validateIdempotencyKey(input.idempotencyKey);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(taskId, safeInput.idempotencyKey);
    const existingOperation = this.#taskTransitionOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "task transition", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const task = this.#requiredTask(taskId);
    if (!isTaskTransitionAllowed(task.status, safeInput.status)) {
      throw invalidTransition("task", task.id, task.status, safeInput.status);
    }
    const branch = this.#requiredBranch(task.branchId);
    if (branch.status === "merged" || branch.status === "archived" || branch.status === "cancelled") {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Task "${task.id}" cannot transition while branch "${branch.id}" is "${branch.status}".`
      );
    }

    const at = safeInput.createdAt ?? new Date().toISOString();
    const next: ConversationTask = {
      ...task,
      status: safeInput.status,
      ...(safeInput.output === undefined ? {} : { output: safeInput.output }),
      ...(safeInput.error === undefined ? {} : { error: safeInput.error }),
      ...(safeInput.artifacts === undefined ? {} : { artifacts: safeInput.artifacts }),
      updatedAt: at,
      ...(safeInput.status === "running" && task.startedAt === undefined ? { startedAt: at } : {}),
      ...(isTerminalTaskStatus(safeInput.status) && task.finishedAt === undefined ? { finishedAt: at } : {})
    };
    const causationEventId = last(this.#eventIdsByLine.get(branch.id));
    this.#appendEventInternal(branch.id, {
      type: "task_status_changed",
      idempotencyKey: `internal:task-status:${task.id}:${safeInput.idempotencyKey}`,
      ...(causationEventId === undefined ? {} : { causationEventId }),
      correlationId: branch.id,
      taskId: task.id,
      payload: {
        taskId: task.id,
        fromStatus: task.status,
        toStatus: safeInput.status,
        ...(safeInput.output === undefined ? {} : { output: safeInput.output }),
        ...(safeInput.error === undefined ? {} : { error: safeInput.error }),
        ...(safeInput.artifacts === undefined ? {} : { artifacts: safeInput.artifacts })
      },
      createdAt: at
    });
    this.#tasks.set(task.id, cloneValue(next));
    this.#taskTransitionOps.set(operationKey, { signature, value: cloneValue(next) });
    return cloneValue(next);
  }

  async createBranchResult(branchId: string, input: CreateBranchResultInput): Promise<BranchResult> {
    validateCreateBranchResultInput(input);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(branchId, safeInput.idempotencyKey);
    const existingOperation = this.#resultCreateOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "branch result creation", safeInput.idempotencyKey);
      await this.#ensureResultNode(
        existingOperation.value,
        required(this.#resultEventIds, existingOperation.value.id, "branch result event")
      );
      return cloneValue(existingOperation.value);
    }

    const branch = this.#requiredBranch(branchId);
    assertBranchCanCreateResult(branch, safeInput.status);
    const sourceTaskIds = [...new Set(safeInput.sourceTaskIds ?? [])];
    if (sourceTaskIds.length !== (safeInput.sourceTaskIds?.length ?? 0)) {
      throw validationError("sourceTaskIds must not contain duplicates.");
    }
    for (const taskId of sourceTaskIds) {
      const task = this.#requiredTask(taskId);
      if (task.sessionId !== branch.sessionId || task.branchId !== branch.id) {
        throw ownershipMismatch(`Result task "${task.id}" must belong to branch "${branch.id}".`);
      }
      if (!isTerminalTaskStatus(task.status)) {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Result task "${task.id}" must be terminal before its output can be recorded.`
        );
      }
    }
    if (safeInput.sourceEventId !== undefined) {
      const sourceEvent = this.#requiredEvent(safeInput.sourceEventId);
      if (sourceEvent.sessionId !== branch.sessionId || sourceEvent.lineId !== branch.id) {
        throw ownershipMismatch(`Result source event "${sourceEvent.id}" must belong to branch "${branch.id}".`);
      }
    }

    const branchResultIds = this.#resultIdsByBranch.get(branch.id) ?? [];
    const expectedVersion = branchResultIds.length + 1;
    const version = safeInput.version ?? expectedVersion;
    if (version !== expectedVersion) {
      throw conflict(
        `Branch "${branch.id}" expects result version ${expectedVersion}, but version ${version} was requested.`
      );
    }
    const resultId = safeInput.id ?? `branch-result-${randomUUID()}`;
    if (this.#results.has(resultId)) {
      throw conflict(`Branch result "${resultId}" already exists.`);
    }

    const now = safeInput.createdAt ?? new Date().toISOString();
    const result: BranchResult = {
      id: resultId,
      sessionId: branch.sessionId,
      branchId: branch.id,
      version,
      status: safeInput.status,
      summary: safeInput.summary,
      artifacts: safeInput.artifacts ?? [],
      citations: safeInput.citations ?? [],
      nextActions: safeInput.nextActions ?? [],
      sourceTaskIds,
      idempotencyKey: safeInput.idempotencyKey,
      ...(safeInput.sourceEventId === undefined ? {} : { sourceEventId: safeInput.sourceEventId }),
      createdAt: now
    };
    this.#results.set(result.id, cloneValue(result));
    appendIndex(this.#resultIdsByBranch, branch.id, result.id);
    const causationEventId = safeInput.sourceEventId ?? last(this.#eventIdsByLine.get(branch.id));
    const resultEvent = this.#appendEventInternal(branch.id, {
      type: "branch_result",
      idempotencyKey: `internal:branch-result:${result.id}`,
      ...(safeInput.sourceEventId === undefined ? {} : { sourceEventId: safeInput.sourceEventId }),
      ...(causationEventId === undefined ? {} : { causationEventId }),
      correlationId: branch.id,
      payload: {
        resultId: result.id,
        branchId: branch.id,
        version: result.version,
        status: result.status,
        goal: branch.goal,
        summary: result.summary,
        artifacts: result.artifacts,
        citations: result.citations,
        nextActions: result.nextActions,
        sourceTaskIds: result.sourceTaskIds
      },
      createdAt: now
    });
    this.#resultEventIds.set(result.id, resultEvent.id);

    this.#resultCreateOps.set(operationKey, { signature, value: cloneValue(result) });
    await this.#ensureResultNode(result, resultEvent.id);
    return cloneValue(result);
  }

  async getBranchResult(resultId: string): Promise<BranchResult | undefined> {
    return cloneOptional(this.#results.get(resultId));
  }

  async listBranchResults(branchId: string): Promise<readonly BranchResult[]> {
    this.#requiredBranch(branchId);
    return cloneValue(
      (this.#resultIdsByBranch.get(branchId) ?? []).map((resultId) =>
        required(this.#results, resultId, "branch result")
      )
    );
  }

  /**
   * 将阶段结果发布到主线并保留原分支生命周期
   */
  async publishBranchResult(
    branchId: string,
    mainlineId: string,
    input: PublishBranchResultInput = {}
  ): Promise<BranchMerge> {
    const safeInput = cloneValue(input);
    const branch = this.#requiredBranch(branchId);
    const mainline = this.#requiredMainlineById(mainlineId);
    if (mainline.sessionId !== branch.sessionId || branch.parentMainlineId !== mainline.id) {
      throw ownershipMismatch(
        `Branch "${branch.id}" and mainline "${mainline.id}" must belong to the same parent relationship.`
      );
    }

    const result =
      safeInput.resultId === undefined
        ? this.#latestResult(branch.id)
        : required(this.#results, safeInput.resultId, "branch result");
    if (result.branchId !== branch.id || result.sessionId !== branch.sessionId) {
      throw ownershipMismatch(`Result "${result.id}" does not belong to branch "${branch.id}".`);
    }
    const idempotencyKey = safeInput.idempotencyKey ?? `result:${result.id}`;
    validateIdempotencyKey(idempotencyKey);
    const signature = cloneValue({ branchId, mainlineId, ...safeInput, resultId: result.id, idempotencyKey });
    const operationKey = scopedKey(branch.id, idempotencyKey);
    const existingOperation = this.#mergeOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "branch merge", idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const existingMerge = this.#mergesByResult.get(result.id);
    if (existingMerge !== undefined) {
      this.#mergeOps.set(operationKey, { signature, value: cloneValue(existingMerge) });
      return cloneValue(existingMerge);
    }
    const mergeId = safeInput.id ?? `branch-merge-${randomUUID()}`;
    if (this.#merges.has(mergeId)) {
      throw conflict(`Branch merge "${mergeId}" already exists.`);
    }
    const requestedEventIds = [safeInput.eventId, safeInput.branchEventId].filter(
      (eventId): eventId is string => eventId !== undefined
    );
    if (new Set(requestedEventIds).size !== requestedEventIds.length) {
      throw conflict("Mainline and branch merge events must use different ids.");
    }
    for (const eventId of requestedEventIds) {
      if (this.#events.has(eventId)) {
        throw conflict(`Line event "${eventId}" already exists.`);
      }
    }
    const now = safeInput.createdAt ?? new Date().toISOString();
    const resultEventId = required(this.#resultEventIds, result.id, "branch result event");
    const mainlineEvent = this.#appendEventInternal(mainline.id, {
      ...(safeInput.eventId === undefined ? {} : { id: safeInput.eventId }),
      type: "branch_result",
      idempotencyKey: `internal:merge-result:${result.id}:mainline`,
      sourceEventId: resultEventId,
      causationEventId: resultEventId,
      correlationId: branch.id,
      payload: {
        resultId: result.id,
        branchId: branch.id,
        version: result.version,
        status: result.status,
        goal: branch.goal,
        summary: result.summary,
        artifacts: result.artifacts,
        citations: result.citations,
        nextActions: result.nextActions,
        sourceTaskIds: result.sourceTaskIds
      },
      createdAt: now
    });
    const branchEvent = this.#appendEventInternal(
      branch.id,
      {
        ...(safeInput.branchEventId === undefined ? {} : { id: safeInput.branchEventId }),
        type: "branch_result_published",
        idempotencyKey: `internal:merge-result:${result.id}:branch`,
        sourceEventId: resultEventId,
        causationEventId: mainlineEvent.id,
        correlationId: branch.id,
        payload: {
          resultId: result.id,
          version: result.version,
          mainlineId: mainline.id,
          mainlineEventId: mainlineEvent.id
        },
        createdAt: now
      },
      { allowArchivedLine: branch.status === "archived" }
    );
    const merge: BranchMerge = {
      id: mergeId,
      sessionId: branch.sessionId,
      branchId: branch.id,
      resultId: result.id,
      mainlineId: mainline.id,
      mainlineEventId: mainlineEvent.id,
      branchEventId: branchEvent.id,
      idempotencyKey,
      createdAt: now
    };
    const nextBranch = { ...branch, updatedAt: now, mergedAt: branch.mergedAt ?? now };
    this.#lines.set(branch.id, cloneValue(nextBranch));
    this.#merges.set(merge.id, cloneValue(merge));
    this.#mergesByResult.set(result.id, cloneValue(merge));
    this.#mergeOps.set(operationKey, { signature, value: cloneValue(merge) });
    return cloneValue(merge);
  }

  async mergeBranchResult(
    branchId: string,
    mainlineId: string,
    input: MergeBranchResultInput = {}
  ): Promise<BranchMerge> {
    return this.publishBranchResult(branchId, mainlineId, input);
  }

  async createNode(lineId: string, input: CreateConversationNodeInput): Promise<ConversationNode> {
    validateCreateConversationNodeInput(input);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(lineId, safeInput.idempotencyKey);
    const existingOperation = this.#nodeCreateOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "conversation node creation", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const line = this.#requiredLine(lineId);
    const parentIds =
      safeInput.parentIds === undefined
        ? this.#lineHeads.get(line.id) === undefined
          ? []
          : [this.#lineHeads.get(line.id)!.nodeId]
        : uniqueIds(safeInput.parentIds, "parentIds");
    for (const parentId of parentIds) {
      const parent = this.#requiredNode(parentId);
      if (parent.sessionId !== line.sessionId) {
        throw ownershipMismatch(`Conversation node parent "${parent.id}" must belong to session "${line.sessionId}".`);
      }
    }
    const sourceEventIds = uniqueIds(safeInput.sourceEventIds ?? [], "sourceEventIds");
    for (const eventId of sourceEventIds) {
      const event = this.#requiredEvent(eventId);
      if (event.sessionId !== line.sessionId) {
        throw ownershipMismatch(
          `Conversation node source event "${event.id}" must belong to session "${line.sessionId}".`
        );
      }
    }
    const sourceTaskIds = uniqueIds(safeInput.sourceTaskIds ?? [], "sourceTaskIds");
    for (const taskId of sourceTaskIds) {
      const task = this.#requiredTask(taskId);
      if (task.sessionId !== line.sessionId) {
        throw ownershipMismatch(
          `Conversation node source task "${task.id}" must belong to session "${line.sessionId}".`
        );
      }
    }
    const sourceResultIds = uniqueIds(safeInput.sourceResultIds ?? [], "sourceResultIds");
    for (const resultId of sourceResultIds) {
      const result = required(this.#results, resultId, "branch result");
      if (result.sessionId !== line.sessionId) {
        throw ownershipMismatch(
          `Conversation node source result "${result.id}" must belong to session "${line.sessionId}".`
        );
      }
    }

    const nodeId = safeInput.id ?? `conversation-node-${randomUUID()}`;
    if (this.#nodes.has(nodeId)) {
      throw conflict(`Conversation node "${nodeId}" already exists.`);
    }
    const createdAt = safeInput.createdAt ?? new Date().toISOString();
    const node: ConversationNode = {
      id: nodeId,
      ordinal: this.#nextNodeOrdinal,
      sequence: (this.#nodeIdsByLine.get(line.id)?.length ?? 0) + 1,
      sessionId: line.sessionId,
      lineId: line.id,
      parentIds,
      kind: safeInput.kind,
      title: safeInput.title,
      statePatch: safeInput.statePatch,
      sourceEventIds,
      sourceTaskIds,
      sourceResultIds,
      createdBy: safeInput.createdBy,
      idempotencyKey: safeInput.idempotencyKey,
      createdAt
    };
    this.#nextNodeOrdinal += 1;
    this.#nodes.set(node.id, cloneValue(node));
    appendIndex(this.#nodeIdsByLine, line.id, node.id);
    this.#lineHeads.set(line.id, {
      lineId: line.id,
      nodeId: node.id,
      updatedAt: createdAt
    });
    this.#nodeCreateOps.set(operationKey, { signature, value: cloneValue(node) });
    return cloneValue(node);
  }

  async getNode(nodeId: string): Promise<ConversationNode | undefined> {
    return cloneOptional(this.#nodes.get(nodeId));
  }

  async listNodes(lineId: string, options: ListConversationNodesOptions = {}): Promise<readonly ConversationNode[]> {
    validateListConversationNodesOptions(options);
    this.#requiredLine(lineId);
    const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
    const matches = (this.#nodeIdsByLine.get(lineId) ?? [])
      .map((nodeId) => required(this.#nodes, nodeId, "conversation node"))
      .filter((node) => options.afterOrdinal === undefined || node.ordinal > options.afterOrdinal)
      .filter((node) => options.beforeOrdinal === undefined || node.ordinal < options.beforeOrdinal)
      .filter((node) => kinds === undefined || kinds.has(node.kind));
    return cloneValue(options.limit === undefined ? matches : matches.slice(-options.limit));
  }

  async getLineHead(lineId: string): Promise<ConversationLineHead | undefined> {
    this.#requiredLine(lineId);
    return cloneOptional(this.#lineHeads.get(lineId));
  }

  async createContextSnapshot(
    lineId: string,
    input: CreateConversationContextSnapshotInput
  ): Promise<ConversationContextSnapshot> {
    validateIdempotencyKey(input.idempotencyKey);
    const safeInput = cloneValue(input);
    const operationKey = scopedKey(lineId, safeInput.idempotencyKey);
    const currentHead = this.#lineHeads.get(lineId);
    const nodeId = safeInput.nodeId ?? currentHead?.nodeId;
    if (nodeId === undefined) {
      throw validationError(`Line "${lineId}" has no semantic node to snapshot.`);
    }
    const signature = { ...safeInput, nodeId };
    const existingOperation = this.#snapshotCreateOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(
        existingOperation.signature,
        signature,
        "conversation context snapshot creation",
        safeInput.idempotencyKey
      );
      return cloneValue(existingOperation.value);
    }

    const line = this.#requiredLine(lineId);
    const node = this.#requiredNode(nodeId);
    if (node.sessionId !== line.sessionId || node.lineId !== line.id) {
      throw ownershipMismatch(`Snapshot node "${node.id}" must belong to line "${line.id}".`);
    }
    const reconstructed = this.#reconstructLineState(line.id, node.id);
    const snapshotId = safeInput.id ?? `conversation-snapshot-${randomUUID()}`;
    if (this.#snapshots.has(snapshotId)) {
      throw conflict(`Conversation context snapshot "${snapshotId}" already exists.`);
    }
    const snapshot: ConversationContextSnapshot = {
      id: snapshotId,
      sessionId: line.sessionId,
      lineId: line.id,
      nodeId: node.id,
      nodeOrdinal: node.ordinal,
      state: reconstructed.state,
      idempotencyKey: safeInput.idempotencyKey,
      createdAt: safeInput.createdAt ?? new Date().toISOString()
    };
    this.#snapshots.set(snapshot.id, cloneValue(snapshot));
    appendIndex(this.#snapshotIdsByLine, line.id, snapshot.id);
    this.#snapshotCreateOps.set(operationKey, { signature, value: cloneValue(snapshot) });
    return cloneValue(snapshot);
  }

  async getLatestContextSnapshot(lineId: string): Promise<ConversationContextSnapshot | undefined> {
    this.#requiredLine(lineId);
    const id = last(this.#snapshotIdsByLine.get(lineId));
    return id === undefined ? undefined : cloneValue(required(this.#snapshots, id, "conversation context snapshot"));
  }

  async reconstructLineState(lineId: string, headNodeId?: string): Promise<ReconstructedConversationState> {
    return cloneValue(this.#reconstructLineState(lineId, headNodeId));
  }

  async getBranchContext(branchId: string): Promise<BranchContext> {
    const branch = this.#requiredBranch(branchId);
    const session = this.#requiredSession(branch.sessionId);
    const mainline = this.#requiredMainline(session);
    const sourceEvent = this.#requiredEvent(branch.sourceEventId);
    const context: BranchContext = {
      session,
      mainline,
      branch,
      sourceEvent,
      ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot }),
      events: (this.#eventIdsByLine.get(branch.id) ?? []).map((id) => required(this.#events, id, "line event")),
      tasks: (this.#taskIdsByBranch.get(branch.id) ?? []).map((id) => required(this.#tasks, id, "task")),
      results: (this.#resultIdsByBranch.get(branch.id) ?? []).map((id) => required(this.#results, id, "branch result"))
    };
    return cloneValue(context);
  }

  async getRecoveryState(sessionId?: string): Promise<ConversationRecoveryState> {
    if (sessionId !== undefined) {
      this.#requiredSession(sessionId);
    }
    const matchesSession = (valueSessionId: string) => sessionId === undefined || valueSessionId === sessionId;
    const sessions = [...this.#sessions.values()].filter(
      (session) => matchesSession(session.id) && session.status === "active"
    );
    const activeSessionIds = new Set(sessions.map((session) => session.id));
    const mainlines = sessions.map((session) => this.#requiredMainline(session));
    const activeBranches = [...this.#lines.values()].filter(
      (line): line is ConversationBranch =>
        line.kind === "branch" && activeSessionIds.has(line.sessionId) && ACTIVE_BRANCH_STATUSES.has(line.status)
    );
    const unfinishedTasks = [...this.#tasks.values()].filter(
      (task) => activeSessionIds.has(task.sessionId) && UNFINISHED_TASK_STATUSES.has(task.status)
    );
    const unmergedResults = [...this.#results.values()].filter((result) => {
      const branch = this.#lines.get(result.branchId);
      return (
        activeSessionIds.has(result.sessionId) &&
        branch?.kind === "branch" &&
        branch.status !== "failed" &&
        branch.status !== "cancelled" &&
        result.status === "completed" &&
        !this.#mergesByResult.has(result.id)
      );
    });
    return cloneValue({ sessions, mainlines, activeBranches, unfinishedTasks, unmergedResults });
  }

  async getTaskTrace(taskId: string): Promise<TaskTrace> {
    const task = this.#requiredTask(taskId);
    const branch = this.#requiredBranch(task.branchId);
    const session = this.#requiredSession(task.sessionId);
    const mainline = this.#requiredMainline(session);
    const sourceEvent =
      task.sourceEventId === undefined ? undefined : required(this.#events, task.sourceEventId, "line event");
    const branchSourceEvent = this.#requiredEvent(branch.sourceEventId);
    const events = [...this.#events.values()].filter(
      (event) =>
        event.sessionId === task.sessionId &&
        (event.taskId === task.id || (event.payload !== undefined && payloadContainsTaskId(event.payload, task.id)))
    );
    const results = [...this.#results.values()].filter((result) => result.sourceTaskIds.includes(task.id));
    return cloneValue({
      task,
      branch,
      mainline,
      session,
      ...(sourceEvent === undefined ? {} : { sourceEvent }),
      branchSourceEvent,
      events,
      results
    });
  }

  async getEventTrace(eventId: string): Promise<EventTrace> {
    const event = this.#requiredEvent(eventId);
    const line = this.#requiredLine(event.lineId);
    const session = this.#requiredSession(event.sessionId);
    const branch = line.kind === "branch" ? line : undefined;
    const task = event.taskId === undefined ? undefined : this.#requiredTask(event.taskId);
    const sourceEvent = event.sourceEventId === undefined ? undefined : this.#events.get(event.sourceEventId);
    const causationChain = this.#causationChain(event);
    const relatedEvents = collectRelatedEvents(
      [...this.#events.values()].filter((candidate) => candidate.sessionId === event.sessionId),
      event,
      causationChain
    );
    return cloneValue({
      event,
      line,
      session,
      ...(branch === undefined ? {} : { branch }),
      ...(task === undefined ? {} : { task }),
      ...(sourceEvent === undefined ? {} : { sourceEvent }),
      causationChain,
      relatedEvents
    });
  }

  async getBranchResultTrace(resultId: string): Promise<BranchResultTrace> {
    const result = required(this.#results, resultId, "branch result");
    const branch = this.#requiredBranch(result.branchId);
    const session = this.#requiredSession(result.sessionId);
    const mainline = this.#requiredMainline(session);
    const sourceEvent =
      result.sourceEventId === undefined ? undefined : required(this.#events, result.sourceEventId, "line event");
    const tasks = result.sourceTaskIds.map((taskId) => this.#requiredTask(taskId));
    const merge = this.#mergesByResult.get(result.id);
    const mainlineEvent = merge === undefined ? undefined : required(this.#events, merge.mainlineEventId, "line event");
    return cloneValue({
      result,
      branch,
      mainline,
      session,
      ...(sourceEvent === undefined ? {} : { sourceEvent }),
      tasks,
      ...(merge === undefined ? {} : { publication: merge, merge }),
      ...(mainlineEvent === undefined ? {} : { mainlineEvent })
    });
  }

  #createSession(input: CreateSessionInput): ConversationSession {
    validateCreateSessionInput(input);
    const safeInput = cloneValue(input);
    const sessionId = sessionIdFromInput(safeInput);
    const idempotencyKey = safeInput.idempotencyKey ?? sessionId;
    const signature = cloneValue({ ...safeInput, id: sessionId, sessionId: undefined, idempotencyKey });
    const existingOperation = this.#sessionCreateOps.get(idempotencyKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "session creation", idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const ensured = this.#ensureSessionInternal({ ...safeInput, id: sessionId });
    if (!ensured.created) {
      const existingSignature = this.#sessionCreateSignatures.get(sessionId);
      if (existingSignature !== undefined) {
        assertSameRequest(existingSignature, sessionCreateEntitySignature(safeInput, sessionId), "session", sessionId);
      }
    }
    this.#sessionCreateOps.set(idempotencyKey, { signature, value: cloneValue(ensured.session) });
    return cloneValue(ensured.session);
  }

  #ensureSessionInternal(input: CreateSessionInput): {
    readonly session: ConversationSession;
    readonly mainline: ConversationMainline;
    readonly created: boolean;
  } {
    validateCreateSessionInput(input);
    const safeInput = cloneValue(input);
    const sessionId = sessionIdFromInput(safeInput);
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      const mainline = this.#requiredMainline(existing);
      const requestedMainlineId = safeInput.mainlineId ?? mainline.id;
      if (requestedMainlineId !== mainline.id) {
        throw conflict(`Session "${sessionId}" already uses mainline "${mainline.id}", not "${requestedMainlineId}".`);
      }
      if (safeInput.locator !== undefined && existing.locator !== undefined) {
        assertSameRequest(existing.locator, safeInput.locator, "session locator", sessionId);
      }
      if (safeInput.workspaceId !== undefined && existing.workspaceId !== safeInput.workspaceId) {
        throw conflict(`Session "${sessionId}" is not bound to workspace "${safeInput.workspaceId}".`);
      }
      return { session: existing, mainline, created: false };
    }

    const mainlineId = safeInput.mainlineId ?? `mainline:${sessionId}`;
    if (this.#lines.has(mainlineId)) {
      throw conflict(`Conversation line "${mainlineId}" already exists.`);
    }
    const now = safeInput.createdAt ?? new Date().toISOString();
    const session: ConversationSession = {
      id: sessionId,
      mainlineId,
      status: "active",
      ...(safeInput.locator === undefined ? {} : { locator: safeInput.locator }),
      ...(safeInput.workspaceId === undefined ? {} : { workspaceId: safeInput.workspaceId }),
      ...(safeInput.metadata === undefined ? {} : { metadata: safeInput.metadata }),
      createdAt: now,
      updatedAt: now
    };
    const mainline: ConversationMainline = {
      id: mainlineId,
      sessionId,
      kind: "mainline",
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.#sessions.set(session.id, cloneValue(session));
    this.#lines.set(mainline.id, cloneValue(mainline));
    this.#eventIdsByLine.set(mainline.id, []);
    this.#normalizedEventIdsBySession.set(session.id, []);
    this.#sessionCreateSignatures.set(session.id, sessionCreateEntitySignature(safeInput, sessionId));
    return { session, mainline, created: true };
  }

  #appendEventInternal(
    lineId: string,
    input: AppendLineEventInput,
    options: { readonly allowArchivedLine?: boolean } = {}
  ): LineEvent {
    validateAppendLineEventInput(input);
    const safeInput = cloneValue(input);
    const signature = cloneValue(safeInput);
    const operationKey = scopedKey(lineId, safeInput.idempotencyKey);
    const existingOperation = this.#eventAppendOps.get(operationKey);
    if (existingOperation !== undefined) {
      assertSameRequest(existingOperation.signature, signature, "line event append", safeInput.idempotencyKey);
      return cloneValue(existingOperation.value);
    }

    const line = this.#requiredLine(lineId);
    const session = this.#requiredSession(line.sessionId);
    assertWritableSession(session);
    if (safeInput.sessionId !== undefined && safeInput.sessionId !== line.sessionId) {
      throw ownershipMismatch(`Line "${line.id}" does not belong to session "${safeInput.sessionId}".`);
    }
    if (line.status === "archived" && options.allowArchivedLine !== true) {
      throw new ConversationStoreError("invalid_state_transition", `Cannot append to archived line "${line.id}".`);
    }
    if (safeInput.sourceNormalizedEventId !== undefined) {
      const normalized = required(this.#normalizedEvents, safeInput.sourceNormalizedEventId, "normalized event");
      if (normalized.sessionId !== line.sessionId || normalized.lineId !== line.id) {
        throw ownershipMismatch(
          `Normalized event "${normalized.id}" must target line "${line.id}" in session "${line.sessionId}".`
        );
      }
    }
    for (const relatedEventId of [safeInput.sourceEventId, safeInput.causationEventId]) {
      if (relatedEventId === undefined) {
        continue;
      }
      const related = this.#requiredEvent(relatedEventId);
      if (related.sessionId !== line.sessionId) {
        throw ownershipMismatch(
          `Related event "${related.id}" and target line "${line.id}" must belong to the same session.`
        );
      }
    }
    if (safeInput.taskId !== undefined) {
      const task = this.#requiredTask(safeInput.taskId);
      if (task.sessionId !== line.sessionId) {
        throw ownershipMismatch(`Task "${task.id}" and line "${line.id}" must belong to the same session.`);
      }
      if (line.kind !== "branch" || task.branchId !== line.id) {
        throw ownershipMismatch(`Task "${task.id}" events must be appended to branch "${task.branchId}".`);
      }
    }

    const eventId = safeInput.id ?? `event-${randomUUID()}`;
    if (this.#events.has(eventId)) {
      throw conflict(`Line event "${eventId}" already exists.`);
    }
    const lineEvents = this.#eventIdsByLine.get(line.id) ?? [];
    const event: LineEvent = {
      id: eventId,
      ordinal: this.#nextOrdinal,
      sequence: lineEvents.length + 1,
      sessionId: line.sessionId,
      lineId: line.id,
      type: safeInput.type,
      idempotencyKey: safeInput.idempotencyKey,
      ...(safeInput.sourceNormalizedEventId === undefined
        ? {}
        : { sourceNormalizedEventId: safeInput.sourceNormalizedEventId }),
      ...(safeInput.sourceEventId === undefined ? {} : { sourceEventId: safeInput.sourceEventId }),
      ...(safeInput.causationEventId === undefined ? {} : { causationEventId: safeInput.causationEventId }),
      ...(safeInput.correlationId === undefined ? {} : { correlationId: safeInput.correlationId }),
      ...(safeInput.taskId === undefined ? {} : { taskId: safeInput.taskId }),
      ...(safeInput.actorId === undefined ? {} : { actorId: safeInput.actorId }),
      ...(safeInput.payload === undefined ? {} : { payload: safeInput.payload }),
      createdAt: safeInput.createdAt ?? new Date().toISOString()
    };
    this.#nextOrdinal += 1;
    this.#events.set(event.id, cloneValue(event));
    appendIndex(this.#eventIdsByLine, line.id, event.id);
    this.#eventAppendOps.set(operationKey, { signature, value: cloneValue(event) });
    return cloneValue(event);
  }

  #causationChain(event: LineEvent): readonly LineEvent[] {
    const result: LineEvent[] = [];
    const visited = new Set<string>([event.id]);
    let cursor = event.causationEventId ?? event.sourceEventId;
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      const ancestor = this.#events.get(cursor);
      if (ancestor === undefined) {
        break;
      }
      result.unshift(ancestor);
      cursor = ancestor.causationEventId ?? ancestor.sourceEventId;
    }
    result.push(event);
    return result;
  }

  #assertSessionLocator(session: ConversationSession, input: AcceptNormalizedEventInput): void {
    if (session.locator === undefined) {
      return;
    }
    const expected = {
      platform: input.platform,
      provider: input.provider,
      channelId: input.channelId,
      conversationType: input.conversationType,
      conversationId: input.conversationId
    };
    if (!isDeepStrictEqual(session.locator, expected)) {
      throw ownershipMismatch(`Normalized event locator does not match session "${session.id}".`);
    }
  }

  #latestResult(branchId: string): BranchResult {
    const resultId = last(this.#resultIdsByBranch.get(branchId));
    if (resultId === undefined) {
      throw new ConversationStoreError("not_found", `Branch "${branchId}" has no result to merge.`);
    }
    return required(this.#results, resultId, "branch result");
  }

  async #ensureResultNode(result: BranchResult, resultEventId: string): Promise<void> {
    await this.createNode(result.branchId, {
      id: `conversation-node:result:${result.id}`,
      kind: "task_result",
      title: `记录分支结果 v${result.version}`,
      statePatch: {
        latestResult: {
          id: result.id,
          version: result.version,
          status: result.status,
          summary: result.summary,
          nextActions: result.nextActions,
          sourceTaskIds: result.sourceTaskIds,
          createdAt: result.createdAt
        }
      },
      sourceEventIds: [resultEventId],
      sourceTaskIds: result.sourceTaskIds,
      sourceResultIds: [result.id],
      createdBy: "system",
      idempotencyKey: `branch-result:${result.id}:semantic-node`,
      createdAt: result.createdAt
    });
  }

  #assertBranchTasksTerminal(branchId: string, action: string): void {
    const unfinishedTasks = (this.#taskIdsByBranch.get(branchId) ?? [])
      .map((taskId) => this.#requiredTask(taskId))
      .filter((task) => !isTerminalTaskStatus(task.status));
    if (unfinishedTasks.length !== 0) {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Branch "${branchId}" cannot ${action} while tasks are unfinished: ${unfinishedTasks
          .map((task) => task.id)
          .join(", ")}.`
      );
    }
  }

  #assertSessionCanArchive(sessionId: string): void {
    const unfinishedTask = [...this.#tasks.values()].find(
      (task) => task.sessionId === sessionId && !isTerminalTaskStatus(task.status)
    );
    const openBranch = [...this.#lines.values()].find(
      (line): line is ConversationBranch =>
        line.kind === "branch" && line.sessionId === sessionId && !SESSION_ARCHIVABLE_BRANCH_STATUSES.has(line.status)
    );
    if (unfinishedTask !== undefined || openBranch !== undefined) {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Session "${sessionId}" cannot be archived while branches or tasks are unfinished.`
      );
    }
  }

  #reconstructLineState(lineId: string, headNodeId?: string): ReconstructedConversationState {
    const line = this.#requiredLine(lineId);
    const resolvedHeadId = headNodeId ?? this.#lineHeads.get(line.id)?.nodeId;
    if (resolvedHeadId === undefined) {
      return {
        sessionId: line.sessionId,
        lineId: line.id,
        state: {},
        appliedNodeIds: []
      };
    }
    const head = this.#requiredNode(resolvedHeadId);
    if (head.lineId !== line.id) {
      throw ownershipMismatch(`Conversation node "${head.id}" is not a head candidate for line "${line.id}".`);
    }

    const ancestry = this.#collectNodeAncestry(head);
    const ancestryIds = new Set(ancestry.map((node) => node.id));
    const snapshot = [...this.#snapshots.values()]
      .filter((candidate) => ancestryIds.has(candidate.nodeId))
      .toSorted((left, right) => right.nodeOrdinal - left.nodeOrdinal)[0];
    let state: Readonly<Record<string, unknown>> = snapshot?.state ?? {};
    const nodesToApply = ancestry.filter((node) => snapshot === undefined || node.ordinal > snapshot.nodeOrdinal);
    for (const node of nodesToApply) {
      state = applyConversationStatePatch(state, node.statePatch);
    }

    return {
      sessionId: line.sessionId,
      lineId: line.id,
      headNodeId: head.id,
      ...(snapshot === undefined ? {} : { snapshot }),
      state,
      appliedNodeIds: nodesToApply.map((node) => node.id)
    };
  }

  #collectNodeAncestry(head: ConversationNode): readonly ConversationNode[] {
    const visited = new Set<string>();
    const visit = (node: ConversationNode): void => {
      if (visited.has(node.id)) {
        return;
      }
      for (const parentId of node.parentIds) {
        visit(this.#requiredNode(parentId));
      }
      visited.add(node.id);
    };
    visit(head);
    return [...visited]
      .map((nodeId) => this.#requiredNode(nodeId))
      .toSorted((left, right) => left.ordinal - right.ordinal);
  }

  #requiredSession(sessionId: string): ConversationSession {
    return required(this.#sessions, sessionId, "session");
  }

  #requiredLine(lineId: string): ConversationLine {
    return required(this.#lines, lineId, "conversation line");
  }

  #requiredMainline(session: ConversationSession): ConversationMainline {
    return this.#requiredMainlineById(session.mainlineId);
  }

  #requiredMainlineById(lineId: string): ConversationMainline {
    const line = this.#requiredLine(lineId);
    if (line.kind !== "mainline") {
      throw validationError(`Conversation line "${lineId}" is not a mainline.`);
    }
    return line;
  }

  #requiredBranch(branchId: string): ConversationBranch {
    const line = this.#requiredLine(branchId);
    if (line.kind !== "branch") {
      throw validationError(`Conversation line "${branchId}" is not a branch.`);
    }
    return line;
  }

  #requiredEvent(eventId: string): LineEvent {
    return required(this.#events, eventId, "line event");
  }

  #requiredTask(taskId: string): ConversationTask {
    return required(this.#tasks, taskId, "task");
  }

  #requiredNode(nodeId: string): ConversationNode {
    return required(this.#nodes, nodeId, "conversation node");
  }
}

function normalizedAcceptSignature(input: AcceptNormalizedEventInput): unknown {
  return cloneValue(input);
}

function normalizedOperationKey(input: AcceptNormalizedEventInput): string {
  return input.idempotencyKey;
}

function normalizedSourceKey(input: AcceptNormalizedEventInput): string {
  return [input.platform, input.provider, input.channelId, input.sourceEventId, input.sourceEventType].join("\u001f");
}

function normalizedEventSignature(event: NormalizedEvent): unknown {
  return {
    sessionId: event.sessionId,
    targetLineId: event.lineId,
    platform: event.platform,
    provider: event.provider,
    channelId: event.channelId,
    conversationType: event.conversationType,
    conversationId: event.conversationId,
    sourceEventId: event.sourceEventId,
    ...(event.sourceMessageId === undefined ? {} : { sourceMessageId: event.sourceMessageId }),
    sourceEventType: event.sourceEventType,
    senderId: event.senderId,
    text: event.text,
    ...(event.message === undefined ? {} : { message: event.message }),
    segments: event.segments,
    ...(event.triggerHint === undefined ? {} : { triggerHint: event.triggerHint }),
    ...(event.rawPayload === undefined ? {} : { rawPayload: event.rawPayload }),
    receivedAt: event.receivedAt
  };
}

function normalizedEntitySignatureFromInput(input: AcceptNormalizedEventInput, resolvedLineId: string): unknown {
  return {
    sessionId: input.sessionId,
    targetLineId: input.targetLineId ?? resolvedLineId,
    platform: input.platform,
    provider: input.provider,
    channelId: input.channelId,
    conversationType: input.conversationType,
    conversationId: input.conversationId,
    sourceEventId: input.sourceEventId,
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    sourceEventType: input.sourceEventType,
    senderId: input.senderId,
    text: input.text,
    ...(input.message === undefined ? {} : { message: input.message }),
    segments: input.segments ?? input.message?.segments ?? [],
    ...(input.triggerHint === undefined ? {} : { triggerHint: input.triggerHint }),
    ...(input.rawPayload === undefined ? {} : { rawPayload: input.rawPayload }),
    receivedAt: input.receivedAt
  };
}

function sessionCreateEntitySignature(input: CreateSessionInput, sessionId: string): unknown {
  return cloneValue({
    id: sessionId,
    mainlineId: input.mainlineId ?? `mainline:${sessionId}`,
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
  });
}

function branchWithStatus(branch: ConversationBranch, status: BranchStatus, at: string): ConversationBranch {
  return {
    ...branch,
    status,
    updatedAt: at,
    ...(status === "completed" && branch.completedAt === undefined ? { completedAt: at } : {}),
    ...(status === "merged" && branch.mergedAt === undefined ? { mergedAt: at } : {}),
    ...(status === "archived" && branch.archivedAt === undefined ? { archivedAt: at } : {})
  };
}

function assertLineSession(line: ConversationLine, sessionId: string): void {
  if (line.sessionId !== sessionId) {
    throw ownershipMismatch(`Line "${line.id}" does not belong to session "${sessionId}".`);
  }
}

function assertSameRequest(existing: unknown, incoming: unknown, operation: string, key: string): void {
  if (!isDeepStrictEqual(existing, incoming)) {
    throw new ConversationStoreError(
      "idempotency_conflict",
      `Idempotency key "${key}" was already used for a different ${operation} request.`
    );
  }
}

function required<K, V>(map: ReadonlyMap<K, V>, key: K, kind: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw notFound(kind, String(key));
  }
  return value;
}

function appendIndex(map: Map<string, string[]>, key: string, id: string): void {
  const values = map.get(key);
  if (values === undefined) {
    map.set(key, [id]);
  } else {
    values.push(id);
  }
}

function uniqueIds(values: readonly string[], name: string): readonly string[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw validationError(`${name} must not contain duplicates.`);
  }
  for (const value of unique) {
    validateNonEmpty(name, value);
  }
  return unique;
}

function last<T>(values: readonly T[] | undefined): T | undefined {
  return values?.at(-1);
}

function scopedKey(scope: string, key: string): string {
  return `${scope}\u001f${key}`;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new ConversationStoreError(
      "validation_error",
      `Conversation payload is not structured-cloneable: ${error instanceof Error ? error.message : "unknown error"}.`
    );
  }
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : cloneValue(value);
}

function notFound(kind: string, id: string): ConversationStoreError {
  return new ConversationStoreError("not_found", `${capitalize(kind)} "${id}" does not exist.`);
}

function conflict(message: string): ConversationStoreError {
  return new ConversationStoreError("conflict", message);
}

function validationError(message: string): ConversationStoreError {
  return new ConversationStoreError("validation_error", message);
}

function ownershipMismatch(message: string): ConversationStoreError {
  return new ConversationStoreError("ownership_mismatch", message);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

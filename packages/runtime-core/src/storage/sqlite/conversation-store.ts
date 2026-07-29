import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type AcceptNormalizedEventInput,
  type AcceptedNormalizedEvent,
  type AppendLineEventInput,
  type BranchContext,
  type BranchMerge,
  type BranchResult,
  type BranchResultTrace,
  type ConversationBranch,
  type ConversationContextSnapshot,
  type ConversationLine,
  type ConversationLineHead,
  type ConversationMainline,
  type ConversationNode,
  type ConversationRecoveryState,
  type ConversationSession,
  type ConversationSessionLocator,
  type ConversationTask,
  type CreateBranchInput,
  type CreateBranchResultInput,
  type CreateConversationContextSnapshotInput,
  type CreateConversationNodeInput,
  type CreateSessionInput,
  type CreateTaskInput,
  type EventTrace,
  type LineEvent,
  type LineEventType,
  type ListBranchesOptions,
  type ListConversationNodesOptions,
  type ListLineEventsOptions,
  type ListLinesOptions,
  type ListTasksOptions,
  type MergeBranchResultInput,
  type NormalizedEvent,
  type PublishBranchResultInput,
  type ReconstructedConversationState,
  type TaskTrace,
  type TransitionBranchInput,
  type TransitionSessionInput,
  type TransitionTaskInput
} from "../../conversation/types.js";
import type { ConversationStore } from "../../conversation/store.js";
import { ConversationStoreError } from "../../conversation/errors.js";
import { collectRelatedEvents } from "../../conversation/trace.js";
import { applyConversationStatePatch } from "../../conversation/state.js";
import {
  assertBranchCanCreateResult,
  assertBranchCanCreateTask,
  assertWritableSession,
  BRANCH_STATUSES_REQUIRING_TERMINAL_TASKS,
  invalidTransition,
  isBranchTransitionAllowed,
  isTaskTransitionAllowed,
  isTerminalTaskStatus,
  payloadContainsTaskId,
  SESSION_ARCHIVABLE_BRANCH_STATUSES
} from "../../conversation/rules.js";
import { decodeJson, encodeOptionalJson, encodeRequiredJson, jsonValuesEqual } from "./json-codec.js";
import type {
  LineEventRow,
  LineRow,
  MergeRow,
  NodeRow,
  NormalizedEventRow,
  ResultRow,
  SessionRow,
  SnapshotRow,
  TaskRow
} from "./conversation-rows.js";

const LOCATOR_TYPES = new Set(["private", "group", "channel", "cli", "system"]);

/**
 * 会话存储的 SQLite 实现
 *
 * 仓储借用传入连接且不负责迁移和关闭以便与其他上下文仓储共享事务边界
 */
export class SqliteConversationRepository implements ConversationStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#db.pragma("foreign_keys = ON");
  }

  async acceptNormalizedEvent(input: AcceptNormalizedEventInput): Promise<AcceptedNormalizedEvent> {
    validateNormalizedEventInput(input);
    const segments = input.segments ?? input.message?.segments ?? [];
    encodeRequiredJson(segments, "normalized event segments");
    encodeOptionalJson(input.message, "normalized event message");
    encodeOptionalJson(input.triggerHint, "normalized event trigger hint");
    encodeOptionalJson(input.rawPayload, "normalized event raw payload");
    encodeOptionalJson(input.sessionMetadata, "session metadata");

    return this.#write(() => {
      const existing = this.#getNormalizedEventByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) {
        this.#assertNormalizedEventRetry(existing, input, segments);
        const session = this.#requireSession(existing.sessionId);
        const mainline = this.#requireMainline(existing.sessionId);
        const lineEvent = this.#requireEvent(existing.lineEventId);
        return { event: existing, lineEvent, session, mainline, created: false };
      }

      const duplicateSource = this.#db
        .prepare(`
          SELECT idempotency_key
          FROM normalized_events
          WHERE platform = ?
            AND provider = ?
            AND channel_id = ?
            AND source_event_id = ?
            AND source_event_type = ?
          LIMIT 1
        `)
        .get(input.platform, input.provider, input.channelId, input.sourceEventId, input.sourceEventType) as
        | { readonly idempotency_key: string }
        | undefined;
      if (duplicateSource !== undefined) {
        throw new ConversationStoreError(
          "idempotency_conflict",
          `Normalized source event "${input.sourceEventId}" was already accepted with another request.`
        );
      }

      const session = this.#createOrEnsureSession(
        {
          id: input.sessionId,
          locator: {
            platform: input.platform,
            provider: input.provider,
            channelId: input.channelId,
            conversationType: input.conversationType,
            conversationId: input.conversationId
          },
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.sessionMetadata === undefined ? {} : { metadata: input.sessionMetadata }),
          createdAt: input.receivedAt
        },
        true
      );
      const mainline = this.#requireMainline(session.id);
      const targetLine = this.#requireLine(input.targetLineId ?? mainline.id);
      if (targetLine.sessionId !== session.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Line "${targetLine.id}" does not belong to session "${session.id}".`
        );
      }

      const normalizedEventId = input.id ?? `normalized-event:${randomUUID()}`;
      const lineEventId = input.lineEventId ?? `line-event:${randomUUID()}`;
      this.#assertUnusedNormalizedEventId(normalizedEventId);
      this.#assertUnusedLineEventId(lineEventId);
      const acceptedAt = new Date().toISOString();

      this.#db
        .prepare(`
          INSERT INTO normalized_events (
            id,
            session_id,
            platform,
            provider,
            channel_id,
            conversation_type,
            conversation_id,
            source_event_id,
            source_message_id,
            source_event_type,
            sender_id,
            text,
            message_json,
            segments_json,
            trigger_hint_json,
            raw_payload_json,
            received_at,
            ingested_at,
            idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          normalizedEventId,
          session.id,
          input.platform,
          input.provider,
          input.channelId,
          input.conversationType,
          input.conversationId,
          input.sourceEventId,
          input.sourceMessageId ?? null,
          input.sourceEventType,
          input.senderId,
          input.text,
          encodeOptionalJson(input.message, "normalized event message"),
          encodeRequiredJson(segments, "normalized event segments"),
          encodeOptionalJson(input.triggerHint, "normalized event trigger hint"),
          encodeOptionalJson(input.rawPayload, "normalized event raw payload"),
          input.receivedAt,
          acceptedAt,
          input.idempotencyKey
        );

      const lineEvent = this.#appendLineEvent(targetLine, {
        id: lineEventId,
        sessionId: session.id,
        type: input.lineEventType ?? "user_message",
        idempotencyKey: `normalized:${input.idempotencyKey}`,
        sourceNormalizedEventId: normalizedEventId,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        payload: {
          normalizedEventId,
          text: input.text,
          ...(input.message === undefined ? {} : { message: input.message }),
          segments,
          ...(input.triggerHint === undefined ? {} : { triggerHint: input.triggerHint })
        },
        createdAt: input.receivedAt
      });
      const event = this.#requireNormalizedEvent(normalizedEventId);
      return { event, lineEvent, session, mainline, created: true };
    });
  }

  async getNormalizedEvent(eventId: string): Promise<NormalizedEvent | undefined> {
    validateId(eventId, "normalized event id");
    return this.#getNormalizedEvent(eventId);
  }

  async listNormalizedEvents(sessionId: string): Promise<readonly NormalizedEvent[]> {
    validateId(sessionId, "session id");
    if (this.#getSession(sessionId) === undefined) {
      throw new ConversationStoreError("not_found", `Session "${sessionId}" does not exist.`);
    }
    const rows = this.#db
      .prepare(`
        SELECT
          normalized_events.*,
          line_events.line_id,
          line_events.id AS line_event_id
        FROM normalized_events
        JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.session_id = ?
        ORDER BY normalized_events.received_at, normalized_events.ingested_at, normalized_events.rowid
      `)
      .all(sessionId) as NormalizedEventRow[];
    return rows.map(normalizedEventFromRow);
  }

  async createSession(input: CreateSessionInput): Promise<ConversationSession> {
    validateCreateSessionInput(input);
    encodeOptionalJson(input.metadata, "session metadata");
    return this.#write(() => this.#createOrEnsureSession(input, true));
  }

  async ensureSession(input: CreateSessionInput): Promise<ConversationSession> {
    validateCreateSessionInput(input);
    encodeOptionalJson(input.metadata, "session metadata");
    return this.#write(() => this.#createOrEnsureSession(input, true));
  }

  async getSession(sessionId: string): Promise<ConversationSession | undefined> {
    validateId(sessionId, "session id");
    return this.#getSession(sessionId);
  }

  async transitionSession(sessionId: string, input: TransitionSessionInput): Promise<ConversationSession> {
    validateId(sessionId, "session id");
    validateId(input.idempotencyKey, "idempotency key");
    validateTimestamp(input.createdAt, "createdAt");

    return this.#write(() => {
      const session = this.#requireSession(sessionId);
      const mainline = this.#requireMainline(sessionId);
      const internalKey = `internal:session-status:${input.idempotencyKey}`;
      const existingEvent = this.#getEventByLineAndRequest(mainline.id, internalKey);
      if (existingEvent !== undefined) {
        assertTransitionEventRequest(existingEvent, "session_status_changed", input.status, undefined, input.createdAt);
        return { ...session, status: input.status, updatedAt: existingEvent.createdAt };
      }

      if (session.status !== "active" || input.status !== "archived") {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Session "${sessionId}" cannot transition from "${session.status}" to "${input.status}".`
        );
      }
      this.#assertSessionCanArchive(session.id);

      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#appendLineEvent(mainline, {
        type: "session_status_changed",
        idempotencyKey: internalKey,
        payload: { fromStatus: session.status, toStatus: input.status },
        createdAt
      });
      this.#db
        .prepare("UPDATE conversation_sessions SET status = ?, updated_at = ? WHERE id = ?")
        .run(input.status, createdAt, sessionId);
      this.#db
        .prepare("UPDATE conversation_lines SET status = ?, updated_at = ? WHERE id = ?")
        .run(input.status, createdAt, mainline.id);
      return this.#requireSession(sessionId);
    });
  }

  async getLine(lineId: string): Promise<ConversationLine | undefined> {
    validateId(lineId, "line id");
    return this.#getLine(lineId);
  }

  async getMainline(sessionId: string): Promise<ConversationMainline> {
    validateId(sessionId, "session id");
    return this.#requireMainline(sessionId);
  }

  async listLines(sessionId: string, options: ListLinesOptions = {}): Promise<readonly ConversationLine[]> {
    validateId(sessionId, "session id");
    this.#requireSession(sessionId);
    const clauses = ["session_id = ?"];
    const values: unknown[] = [sessionId];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      values.push(options.kind);
    }
    if (options.statuses !== undefined) {
      if (options.statuses.length === 0) {
        return [];
      }
      clauses.push(`status IN (${placeholders(options.statuses.length)})`);
      values.push(...options.statuses);
    }
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM conversation_lines
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE kind WHEN 'mainline' THEN 0 ELSE 1 END, created_at, id
      `)
      .all(...values) as LineRow[];
    return rows.map(lineFromRow);
  }

  async createBranch(input: CreateBranchInput): Promise<ConversationBranch> {
    validateCreateBranchInput(input);
    encodeOptionalJson(input.contextSnapshot, "branch context snapshot");

    return this.#write(() => {
      const existingRow = this.#db
        .prepare(`
          SELECT *
          FROM conversation_lines
          WHERE session_id = ?
            AND kind = 'branch'
            AND create_request_id = ?
          LIMIT 1
        `)
        .get(input.sessionId, input.idempotencyKey) as LineRow | undefined;
      if (existingRow !== undefined) {
        const existing = requireBranchFromRow(existingRow);
        this.#assertBranchCreateRetry(existing, input);
        return branchCreationSnapshot(existing);
      }

      const session = this.#requireSession(input.sessionId);
      assertWritableSession(session);
      const defaultMainline = this.#requireMainline(session.id);
      const parent = this.#requireMainlineById(input.parentMainlineId ?? defaultMainline.id);
      if (parent.sessionId !== session.id || parent.id !== defaultMainline.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Mainline "${parent.id}" is not the default mainline for session "${session.id}".`
        );
      }
      const sourceEvent = this.#requireEvent(input.sourceEventId);
      if (sourceEvent.sessionId !== session.id || sourceEvent.lineId !== parent.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Source event "${sourceEvent.id}" must belong to mainline "${parent.id}" in session "${session.id}".`
        );
      }

      const branchId = input.id ?? `branch-${randomUUID()}`;
      if (this.#getLine(branchId) !== undefined) {
        throw new ConversationStoreError("conflict", `Conversation line "${branchId}" already exists.`);
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#db
        .prepare(`
          INSERT INTO conversation_lines (
            id,
            session_id,
            kind,
            status,
            parent_mainline_id,
            source_line_event_id,
            create_request_id,
            title,
            goal,
            reason,
            created_by,
            context_snapshot_json,
            created_at,
            updated_at
          ) VALUES (?, ?, 'branch', 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          branchId,
          session.id,
          parent.id,
          sourceEvent.id,
          input.idempotencyKey,
          input.title,
          input.goal,
          input.reason,
          input.createdBy,
          encodeOptionalJson(input.contextSnapshot, "branch context snapshot"),
          createdAt,
          createdAt
        );
      const branch = this.#requireBranch(branchId);
      this.#appendLineEvent(branch, {
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
        createdAt
      });
      return branch;
    });
  }

  async getBranch(branchId: string): Promise<ConversationBranch | undefined> {
    validateId(branchId, "branch id");
    const line = this.#getLine(branchId);
    return line?.kind === "branch" ? line : undefined;
  }

  async listBranches(sessionId: string, options: ListBranchesOptions = {}): Promise<readonly ConversationBranch[]> {
    validateId(sessionId, "session id");
    this.#requireSession(sessionId);
    if (options.statuses?.length === 0) {
      return [];
    }
    const statusClause =
      options.statuses === undefined ? "" : ` AND status IN (${placeholders(options.statuses.length)})`;
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM conversation_lines
        WHERE session_id = ?
          AND kind = 'branch'
          ${statusClause}
        ORDER BY created_at, rowid
      `)
      .all(sessionId, ...(options.statuses ?? [])) as LineRow[];
    return rows.map(requireBranchFromRow);
  }

  async transitionBranch(branchId: string, input: TransitionBranchInput): Promise<ConversationBranch> {
    validateId(branchId, "branch id");
    validateTransitionBranchInput(input);
    encodeOptionalJson(input.payload, "branch transition payload");

    return this.#write(() => {
      const internalKey = `internal:branch-status:${input.idempotencyKey}`;
      const existingEvent = this.#getEventByLineAndRequest(branchId, internalKey);
      if (existingEvent !== undefined) {
        assertTransitionEventRequest(
          existingEvent,
          "branch_status_changed",
          input.status,
          input.payload,
          input.createdAt
        );
        return branchSnapshotAtTransition(this.#requireBranch(branchId), input.status, existingEvent.createdAt);
      }

      const branch = this.#requireBranch(branchId);
      if (input.status === "merged") {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Branch "${branch.id}" can enter "merged" only through mergeBranchResult().`
        );
      }
      if (!isBranchTransitionAllowed(branch.status, input.status)) {
        throw invalidTransition("branch", branch.id, branch.status, input.status);
      }
      if (BRANCH_STATUSES_REQUIRING_TERMINAL_TASKS.has(input.status)) {
        this.#assertBranchTasksTerminal(branch.id, `transition to "${input.status}"`);
      }
      assertWritableSession(this.#requireSession(branch.sessionId));
      const createdAt = input.createdAt ?? new Date().toISOString();
      const causationEventId = this.#lastEventId(branch.id);
      this.#appendLineEvent(branch, {
        type: "branch_status_changed",
        idempotencyKey: internalKey,
        ...(causationEventId === undefined ? {} : { causationEventId }),
        correlationId: branch.id,
        payload: {
          fromStatus: branch.status,
          toStatus: input.status,
          ...(input.payload === undefined ? {} : { detail: input.payload })
        },
        createdAt
      });
      this.#updateBranchStatus(branch.id, input.status, createdAt);
      return this.#requireBranch(branch.id);
    });
  }

  async appendEvent(lineId: string, input: AppendLineEventInput): Promise<LineEvent> {
    validateId(lineId, "line id");
    validateAppendLineEventInput(input);
    encodeOptionalJson(input.payload, "line event payload");
    return this.#write(() => this.#appendLineEvent(this.#requireLine(lineId), input));
  }

  async getEvent(eventId: string): Promise<LineEvent | undefined> {
    validateId(eventId, "line event id");
    return this.#getEvent(eventId);
  }

  async listEvents(lineId: string, options: ListLineEventsOptions = {}): Promise<readonly LineEvent[]> {
    validateId(lineId, "line id");
    validateListLineEventsOptions(options);
    this.#requireLine(lineId);
    if (options.types?.length === 0) {
      return [];
    }
    const clauses = ["line_id = ?"];
    const values: unknown[] = [lineId];
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > ?");
      values.push(options.afterSequence);
    }
    if (options.beforeSequence !== undefined) {
      clauses.push("sequence < ?");
      values.push(options.beforeSequence);
    }
    if (options.types !== undefined) {
      clauses.push(`type IN (${placeholders(options.types.length)})`);
      values.push(...options.types);
    }
    const limitSql = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) {
      values.push(options.limit);
    }
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM (
          SELECT *
          FROM line_events
          WHERE ${clauses.join(" AND ")}
          ORDER BY sequence DESC
          ${limitSql}
        )
        ORDER BY sequence
      `)
      .all(...values) as LineEventRow[];
    return rows.map(lineEventFromRow);
  }

  #assertBranchCreateRetry(existing: ConversationBranch, input: CreateBranchInput): void {
    const session = this.#requireSession(existing.sessionId);
    const parentMainlineId = input.parentMainlineId ?? session.mainlineId;
    const mismatch =
      existing.sessionId !== input.sessionId ||
      existing.parentMainlineId !== parentMainlineId ||
      existing.sourceEventId !== input.sourceEventId ||
      existing.title !== input.title ||
      existing.goal !== input.goal ||
      existing.reason !== input.reason ||
      existing.createdBy !== input.createdBy ||
      !jsonValuesEqual(existing.contextSnapshot, input.contextSnapshot) ||
      (input.id !== undefined && existing.id !== input.id) ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Branch creation request "${input.idempotencyKey}" conflicts with the stored branch.`
      );
    }
  }

  #appendLineEvent(
    line: ConversationLine,
    input: AppendLineEventInput,
    options: { readonly allowArchivedLine?: boolean } = {}
  ): LineEvent {
    const existing = this.#getEventByLineAndRequest(line.id, input.idempotencyKey);
    if (existing !== undefined) {
      this.#assertLineEventRetry(existing, line, input);
      return existing;
    }

    const session = this.#requireSession(line.sessionId);
    assertWritableSession(session);
    if (input.sessionId !== undefined && input.sessionId !== line.sessionId) {
      throw new ConversationStoreError(
        "ownership_mismatch",
        `Line "${line.id}" does not belong to session "${input.sessionId}".`
      );
    }
    if (line.status === "archived" && options.allowArchivedLine !== true) {
      throw new ConversationStoreError("invalid_state_transition", `Cannot append to archived line "${line.id}".`);
    }
    if (input.sourceNormalizedEventId !== undefined) {
      const normalized = this.#getNormalizedEvent(input.sourceNormalizedEventId);
      if (normalized === undefined) {
        const pending = this.#db
          .prepare("SELECT session_id FROM normalized_events WHERE id = ? LIMIT 1")
          .get(input.sourceNormalizedEventId) as { readonly session_id: string } | undefined;
        if (pending === undefined) {
          throw new ConversationStoreError(
            "not_found",
            `Normalized event "${input.sourceNormalizedEventId}" does not exist.`
          );
        }
        if (pending.session_id !== line.sessionId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Normalized event "${input.sourceNormalizedEventId}" does not belong to session "${line.sessionId}".`
          );
        }
      } else if (normalized.sessionId !== line.sessionId || normalized.lineId !== line.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Normalized event "${normalized.id}" must target line "${line.id}" in session "${line.sessionId}".`
        );
      }
    }
    for (const relatedEventId of [input.sourceEventId, input.causationEventId]) {
      if (relatedEventId === undefined) {
        continue;
      }
      const related = this.#requireEvent(relatedEventId);
      if (related.sessionId !== line.sessionId) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Related event "${related.id}" and target line "${line.id}" must belong to the same session.`
        );
      }
    }
    if (input.taskId !== undefined) {
      const task = this.#requireTask(input.taskId);
      if (task.sessionId !== line.sessionId || line.kind !== "branch" || task.branchId !== line.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Task "${task.id}" events must be appended to branch "${task.branchId}".`
        );
      }
    }

    const eventId = input.id ?? `event-${randomUUID()}`;
    this.#assertUnusedLineEventId(eventId);
    const sequenceRow = this.#db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM line_events WHERE line_id = ?")
      .get(line.id) as { readonly sequence: number };
    const createdAt = input.createdAt ?? new Date().toISOString();
    const role = roleFromEventType(input.type);
    const text = textFromPayload(input.payload);
    this.#db
      .prepare(`
        INSERT INTO line_events (
          id,
          session_id,
          line_id,
          sequence,
          type,
          role,
          actor_id,
          text,
          payload_json,
          source_normalized_event_id,
          source_event_id,
          idempotency_key,
          causation_event_id,
          correlation_id,
          task_id,
          branch_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        line.sessionId,
        line.id,
        sequenceRow.sequence,
        input.type,
        role,
        input.actorId ?? null,
        text,
        encodeOptionalJson(input.payload, "line event payload"),
        input.sourceNormalizedEventId ?? null,
        input.sourceEventId ?? null,
        input.idempotencyKey,
        input.causationEventId ?? null,
        input.correlationId ?? null,
        input.taskId ?? null,
        line.kind === "branch" ? line.id : null,
        createdAt
      );
    return this.#requireEvent(eventId);
  }

  #assertLineEventRetry(existing: LineEvent, line: ConversationLine, input: AppendLineEventInput): void {
    const mismatch =
      (input.id !== undefined && existing.id !== input.id) ||
      (input.sessionId !== undefined && existing.sessionId !== input.sessionId) ||
      existing.lineId !== line.id ||
      existing.type !== input.type ||
      existing.sourceNormalizedEventId !== input.sourceNormalizedEventId ||
      existing.sourceEventId !== input.sourceEventId ||
      existing.causationEventId !== input.causationEventId ||
      existing.correlationId !== input.correlationId ||
      existing.taskId !== input.taskId ||
      existing.actorId !== input.actorId ||
      !jsonValuesEqual(existing.payload, input.payload) ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Line event request "${input.idempotencyKey}" conflicts with the stored event.`
      );
    }
  }

  #getEvent(eventId: string): LineEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM line_events WHERE id = ? LIMIT 1").get(eventId) as
      | LineEventRow
      | undefined;
    return row === undefined ? undefined : lineEventFromRow(row);
  }

  #requireEvent(eventId: string): LineEvent {
    const event = this.#getEvent(eventId);
    if (event === undefined) {
      throw new ConversationStoreError("not_found", `Line event "${eventId}" does not exist.`);
    }
    return event;
  }

  #getEventByLineAndRequest(lineId: string, idempotencyKey: string): LineEvent | undefined {
    const row = this.#db
      .prepare("SELECT * FROM line_events WHERE line_id = ? AND idempotency_key = ? LIMIT 1")
      .get(lineId, idempotencyKey) as LineEventRow | undefined;
    return row === undefined ? undefined : lineEventFromRow(row);
  }

  #lastEventId(lineId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT id FROM line_events WHERE line_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(lineId) as { readonly id: string } | undefined;
    return row?.id;
  }

  #requireMainlineById(lineId: string): ConversationMainline {
    const line = this.#requireLine(lineId);
    if (line.kind !== "mainline") {
      throw new ConversationStoreError("validation_error", `Conversation line "${lineId}" is not a mainline.`);
    }
    return line;
  }

  #requireBranch(branchId: string): ConversationBranch {
    const line = this.#requireLine(branchId);
    if (line.kind !== "branch") {
      throw new ConversationStoreError("validation_error", `Conversation line "${branchId}" is not a branch.`);
    }
    return line;
  }

  #updateBranchStatus(branchId: string, status: ConversationBranch["status"], at: string): void {
    this.#db
      .prepare(`
        UPDATE conversation_lines
        SET status = ?,
            updated_at = ?,
            completed_at = CASE
              WHEN ? = 'completed' THEN COALESCE(completed_at, ?)
              ELSE completed_at
            END,
            merged_at = CASE
              WHEN ? = 'merged' THEN COALESCE(merged_at, ?)
              ELSE merged_at
            END,
            archived_at = CASE
              WHEN ? = 'archived' THEN COALESCE(archived_at, ?)
              ELSE archived_at
            END
        WHERE id = ?
      `)
      .run(status, at, status, at, status, at, status, at, branchId);
  }

  async createTask(branchId: string, input: CreateTaskInput): Promise<ConversationTask> {
    validateId(branchId, "branch id");
    validateCreateTaskInput(input);
    encodeRequiredJson(input.input, "task input");
    encodeRequiredJson(input.artifacts ?? [], "task artifacts");

    return this.#write(() => {
      const existingRow = this.#db
        .prepare(`
          SELECT *
          FROM conversation_tasks
          WHERE branch_line_id = ? AND create_request_id = ?
          LIMIT 1
        `)
        .get(branchId, input.idempotencyKey) as TaskRow | undefined;
      if (existingRow !== undefined) {
        const existing = taskFromRow(existingRow);
        this.#assertTaskCreateRetry(existing, input);
        return this.#taskCreationSnapshot(existing);
      }

      const branch = this.#requireBranch(branchId);
      assertBranchCanCreateTask(branch);
      assertWritableSession(this.#requireSession(branch.sessionId));
      if (input.sourceEventId !== undefined) {
        const sourceEvent = this.#requireEvent(input.sourceEventId);
        if (sourceEvent.sessionId !== branch.sessionId || sourceEvent.lineId !== branch.id) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Task source event "${sourceEvent.id}" must belong to branch "${branch.id}".`
          );
        }
      }

      const taskId = input.id ?? `task-${randomUUID()}`;
      if (this.#getTask(taskId) !== undefined) {
        throw new ConversationStoreError("conflict", `Task "${taskId}" already exists.`);
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      const artifacts = input.artifacts ?? [];
      this.#db
        .prepare(`
          INSERT INTO conversation_tasks (
            id,
            session_id,
            branch_line_id,
            workspace_id,
            executor,
            status,
            input_json,
            artifacts_json,
            create_request_id,
            source_event_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          taskId,
          branch.sessionId,
          branch.id,
          input.workspaceId ?? null,
          input.executor,
          encodeRequiredJson(input.input, "task input"),
          encodeRequiredJson(artifacts, "task artifacts"),
          input.idempotencyKey,
          input.sourceEventId ?? null,
          createdAt,
          createdAt
        );
      const task = this.#requireTask(taskId);
      const causationEventId = input.sourceEventId ?? this.#lastEventId(branch.id);
      this.#appendLineEvent(branch, {
        type: "task_created",
        idempotencyKey: `internal:task-created:${task.id}`,
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
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
        createdAt
      });
      return task;
    });
  }

  async getTask(taskId: string): Promise<ConversationTask | undefined> {
    validateId(taskId, "task id");
    return this.#getTask(taskId);
  }

  async listTasks(branchId: string, options: ListTasksOptions = {}): Promise<readonly ConversationTask[]> {
    validateId(branchId, "branch id");
    this.#requireBranch(branchId);
    if (options.statuses?.length === 0) {
      return [];
    }
    const statusClause =
      options.statuses === undefined ? "" : ` AND status IN (${placeholders(options.statuses.length)})`;
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM conversation_tasks
        WHERE branch_line_id = ?
          ${statusClause}
        ORDER BY created_at, rowid
      `)
      .all(branchId, ...(options.statuses ?? [])) as TaskRow[];
    return rows.map(taskFromRow);
  }

  async transitionTask(taskId: string, input: TransitionTaskInput): Promise<ConversationTask> {
    validateId(taskId, "task id");
    validateTransitionTaskInput(input);
    encodeOptionalJson(input.output, "task output");
    encodeOptionalJson(input.error, "task error");
    encodeOptionalJson(input.artifacts, "task artifacts");

    return this.#write(() => {
      const task = this.#requireTask(taskId);
      const internalKey = `internal:task-status:${task.id}:${input.idempotencyKey}`;
      const existingEvent = this.#getEventByLineAndRequest(task.branchId, internalKey);
      if (existingEvent !== undefined) {
        assertTaskTransitionEventRequest(existingEvent, input);
        return this.#taskSnapshotAtEvent(task, existingEvent);
      }

      if (!isTaskTransitionAllowed(task.status, input.status)) {
        throw invalidTransition("task", task.id, task.status, input.status);
      }
      const branch = this.#requireBranch(task.branchId);
      if (branch.status === "merged" || branch.status === "archived" || branch.status === "cancelled") {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Task "${task.id}" cannot transition while branch "${branch.id}" is "${branch.status}".`
        );
      }
      assertWritableSession(this.#requireSession(branch.sessionId));

      const createdAt = input.createdAt ?? new Date().toISOString();
      const causationEventId = this.#lastEventId(branch.id);
      this.#appendLineEvent(branch, {
        type: "task_status_changed",
        idempotencyKey: internalKey,
        ...(causationEventId === undefined ? {} : { causationEventId }),
        correlationId: branch.id,
        taskId: task.id,
        payload: {
          taskId: task.id,
          fromStatus: task.status,
          toStatus: input.status,
          ...(input.output === undefined ? {} : { output: input.output }),
          ...(input.error === undefined ? {} : { error: input.error }),
          ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts })
        },
        createdAt
      });
      this.#db
        .prepare(`
          UPDATE conversation_tasks
          SET status = ?,
              output_json = CASE WHEN ? IS NULL THEN output_json ELSE ? END,
              error_json = CASE WHEN ? IS NULL THEN error_json ELSE ? END,
              artifacts_json = CASE WHEN ? IS NULL THEN artifacts_json ELSE ? END,
              started_at = CASE
                WHEN ? = 'running' THEN COALESCE(started_at, ?)
                ELSE started_at
              END,
              finished_at = CASE
                WHEN ? IN ('completed', 'failed', 'cancelled') THEN COALESCE(finished_at, ?)
                ELSE finished_at
              END,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.status,
          input.output === undefined ? null : 1,
          encodeOptionalJson(input.output, "task output"),
          input.error === undefined ? null : 1,
          encodeOptionalJson(input.error, "task error"),
          input.artifacts === undefined ? null : 1,
          encodeOptionalJson(input.artifacts, "task artifacts"),
          input.status,
          createdAt,
          input.status,
          createdAt,
          createdAt,
          task.id
        );
      return this.#requireTask(task.id);
    });
  }

  async createBranchResult(branchId: string, input: CreateBranchResultInput): Promise<BranchResult> {
    validateId(branchId, "branch id");
    validateCreateBranchResultInput(input);
    encodeRequiredJson(input.artifacts ?? [], "branch result artifacts");
    encodeRequiredJson(input.citations ?? [], "branch result citations");

    const result = this.#write(() => {
      const existingRow = this.#db
        .prepare(`
          SELECT *
          FROM branch_results
          WHERE branch_line_id = ? AND create_request_id = ?
          LIMIT 1
        `)
        .get(branchId, input.idempotencyKey) as ResultRow | undefined;
      if (existingRow !== undefined) {
        const existing = this.#resultFromRow(existingRow);
        this.#assertResultCreateRetry(existing, input);
        return existing;
      }

      const branch = this.#requireBranch(branchId);
      assertBranchCanCreateResult(branch, input.status);
      assertWritableSession(this.#requireSession(branch.sessionId));
      const sourceTaskIds = [...(input.sourceTaskIds ?? [])];
      if (new Set(sourceTaskIds).size !== sourceTaskIds.length) {
        throw new ConversationStoreError("validation_error", "sourceTaskIds must not contain duplicates.");
      }
      for (const taskId of sourceTaskIds) {
        const task = this.#requireTask(taskId);
        if (task.sessionId !== branch.sessionId || task.branchId !== branch.id) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Result task "${task.id}" must belong to branch "${branch.id}".`
          );
        }
        if (!isTerminalTaskStatus(task.status)) {
          throw new ConversationStoreError(
            "invalid_state_transition",
            `Result task "${task.id}" must be terminal before its output can be recorded.`
          );
        }
      }
      if (input.sourceEventId !== undefined) {
        const sourceEvent = this.#requireEvent(input.sourceEventId);
        if (sourceEvent.sessionId !== branch.sessionId || sourceEvent.lineId !== branch.id) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Result source event "${sourceEvent.id}" must belong to branch "${branch.id}".`
          );
        }
      }

      const versionRow = this.#db
        .prepare("SELECT COUNT(*) + 1 AS version FROM branch_results WHERE branch_line_id = ?")
        .get(branch.id) as { readonly version: number };
      const version = input.version ?? versionRow.version;
      if (version !== versionRow.version) {
        throw new ConversationStoreError(
          "conflict",
          `Branch "${branch.id}" expects result version ${versionRow.version}, but version ${version} was requested.`
        );
      }
      const resultId = input.id ?? `branch-result-${randomUUID()}`;
      if (this.#db.prepare("SELECT 1 FROM branch_results WHERE id = ?").get(resultId) !== undefined) {
        throw new ConversationStoreError("conflict", `Branch result "${resultId}" already exists.`);
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#db
        .prepare(`
          INSERT INTO branch_results (
            id,
            session_id,
            branch_line_id,
            version,
            status,
            summary,
            artifacts_json,
            citations_json,
            next_actions_json,
            create_request_id,
            source_event_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          resultId,
          branch.sessionId,
          branch.id,
          version,
          input.status,
          input.summary,
          encodeRequiredJson(input.artifacts ?? [], "branch result artifacts"),
          encodeRequiredJson(input.citations ?? [], "branch result citations"),
          encodeRequiredJson(input.nextActions ?? [], "branch result next actions"),
          input.idempotencyKey,
          input.sourceEventId ?? null,
          createdAt
        );
      const insertTask = this.#db.prepare("INSERT INTO branch_result_tasks (result_id, task_id) VALUES (?, ?)");
      for (const taskId of sourceTaskIds) {
        insertTask.run(resultId, taskId);
      }
      const createdResult = this.#requireBranchResult(resultId);
      const causationEventId = input.sourceEventId ?? this.#lastEventId(branch.id);
      this.#appendLineEvent(branch, {
        type: "branch_result",
        idempotencyKey: `internal:branch-result:${createdResult.id}`,
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
        ...(causationEventId === undefined ? {} : { causationEventId }),
        correlationId: branch.id,
        payload: branchResultPayload(branch, createdResult),
        createdAt
      });
      return createdResult;
    });
    const resultEvent = this.#getEventByLineAndRequest(branchId, `internal:branch-result:${result.id}`);
    if (resultEvent === undefined) {
      throw new ConversationStoreError("not_found", `Branch result event for "${result.id}" does not exist.`);
    }
    await this.#ensureResultNode(result, resultEvent.id);
    return result;
  }

  async getBranchResult(resultId: string): Promise<BranchResult | undefined> {
    validateId(resultId, "branch result id");
    const row = this.#db.prepare("SELECT * FROM branch_results WHERE id = ? LIMIT 1").get(resultId) as
      | ResultRow
      | undefined;
    return row === undefined ? undefined : this.#resultFromRow(row);
  }

  async listBranchResults(branchId: string): Promise<readonly BranchResult[]> {
    validateId(branchId, "branch id");
    this.#requireBranch(branchId);
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM branch_results
        WHERE branch_line_id = ?
        ORDER BY version, rowid
      `)
      .all(branchId) as ResultRow[];
    return rows.map((row) => this.#resultFromRow(row));
  }

  /**
   * 将阶段结果发布到主线并保留原分支生命周期
   */
  async publishBranchResult(
    branchId: string,
    mainlineId: string,
    input: PublishBranchResultInput = {}
  ): Promise<BranchMerge> {
    validateId(branchId, "branch id");
    validateId(mainlineId, "mainline id");
    validateMergeInput(input);

    return this.#write(() => {
      const branch = this.#requireBranch(branchId);
      const mainline = this.#requireMainlineById(mainlineId);
      if (mainline.sessionId !== branch.sessionId || branch.parentMainlineId !== mainline.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Branch "${branch.id}" and mainline "${mainline.id}" must belong to the same parent relationship.`
        );
      }
      const result =
        input.resultId === undefined ? this.#latestResult(branch.id) : this.#requireBranchResult(input.resultId);
      if (result.branchId !== branch.id || result.sessionId !== branch.sessionId) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Result "${result.id}" does not belong to branch "${branch.id}".`
        );
      }
      const idempotencyKey = input.idempotencyKey ?? `result:${result.id}`;
      const existingByRequest = this.#db
        .prepare(`
          SELECT branch_merges.*, conversation_lines.session_id
          FROM branch_merges
          JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
          WHERE branch_merges.branch_line_id = ?
            AND branch_merges.create_request_id = ?
          LIMIT 1
        `)
        .get(branch.id, idempotencyKey) as MergeRow | undefined;
      if (existingByRequest !== undefined) {
        const existing = mergeFromRow(existingByRequest);
        this.#assertMergeRetry(existing, mainline.id, result.id, input);
        return existing;
      }

      const naturalMerge = this.#db
        .prepare(`
          SELECT branch_merges.*, conversation_lines.session_id
          FROM branch_merges
          JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
          WHERE branch_merges.result_id = ?
          ORDER BY branch_merges.rowid
          LIMIT 1
        `)
        .get(result.id) as MergeRow | undefined;
      if (naturalMerge !== undefined) {
        return mergeFromRow(naturalMerge);
      }
      if (result.status !== "completed" || branch.status === "failed" || branch.status === "cancelled") {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Only a completed result on a usable branch can be published; branch="${branch.status}", result="${result.status}".`
        );
      }
      assertWritableSession(this.#requireSession(branch.sessionId));

      const createdAt = input.createdAt ?? new Date().toISOString();
      const resultEvent = this.#getEventByLineAndRequest(branch.id, `internal:branch-result:${result.id}`);
      if (resultEvent === undefined) {
        throw new ConversationStoreError("not_found", `Branch result event for "${result.id}" does not exist.`);
      }
      const mainlineEvent = this.#appendLineEvent(mainline, {
        ...(input.eventId === undefined ? {} : { id: input.eventId }),
        type: "branch_result",
        idempotencyKey: `internal:merge-result:${result.id}:mainline`,
        sourceEventId: resultEvent.id,
        causationEventId: resultEvent.id,
        correlationId: branch.id,
        payload: branchResultPayload(branch, result),
        createdAt
      });
      const branchEvent = this.#appendLineEvent(
        branch,
        {
          ...(input.branchEventId === undefined ? {} : { id: input.branchEventId }),
          type: "branch_result_published",
          idempotencyKey: `internal:merge-result:${result.id}:branch`,
          sourceEventId: resultEvent.id,
          causationEventId: mainlineEvent.id,
          correlationId: branch.id,
          payload: {
            resultId: result.id,
            version: result.version,
            mainlineId: mainline.id,
            mainlineEventId: mainlineEvent.id
          },
          createdAt
        },
        { allowArchivedLine: branch.status === "archived" }
      );
      const mergeId = input.id ?? `branch-merge-${randomUUID()}`;
      const existingMergeId = this.#db.prepare("SELECT 1 FROM branch_merges WHERE id = ?").get(mergeId);
      if (existingMergeId !== undefined) {
        throw new ConversationStoreError("conflict", `Branch merge "${mergeId}" already exists.`);
      }
      this.#db
        .prepare(`
          INSERT INTO branch_merges (
            id,
            result_id,
            branch_line_id,
            mainline_id,
            mainline_event_id,
            branch_event_id,
            create_request_id,
            merged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(mergeId, result.id, branch.id, mainline.id, mainlineEvent.id, branchEvent.id, idempotencyKey, createdAt);
      this.#db
        .prepare(`
          UPDATE conversation_lines
          SET updated_at = ?,
              merged_at = COALESCE(merged_at, ?)
          WHERE id = ?
        `)
        .run(createdAt, createdAt, branch.id);
      return this.#requireMerge(mergeId);
    });
  }

  async mergeBranchResult(
    branchId: string,
    mainlineId: string,
    input: MergeBranchResultInput = {}
  ): Promise<BranchMerge> {
    return this.publishBranchResult(branchId, mainlineId, input);
  }

  async createNode(lineId: string, input: CreateConversationNodeInput): Promise<ConversationNode> {
    validateId(lineId, "line id");
    validateCreateConversationNodeInput(input);

    return this.#write(() => {
      const line = this.#requireLine(lineId);
      const existingRow = this.#db
        .prepare("SELECT * FROM conversation_nodes WHERE line_id = ? AND create_request_id = ? LIMIT 1")
        .get(line.id, input.idempotencyKey) as NodeRow | undefined;
      if (existingRow !== undefined) {
        const existing = this.#nodeFromRow(existingRow);
        this.#assertNodeRetry(existing, input);
        return existing;
      }

      const currentHead = this.#getLineHead(line.id);
      const parentIds =
        input.parentIds === undefined ? (currentHead === undefined ? [] : [currentHead.nodeId]) : input.parentIds;
      const uniqueParentIds = uniqueIds(parentIds, "parentIds");
      for (const parentId of uniqueParentIds) {
        const parent = this.#requireNode(parentId);
        if (parent.sessionId !== line.sessionId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Conversation node parent "${parent.id}" must belong to session "${line.sessionId}".`
          );
        }
      }
      const sourceEventIds = uniqueIds(input.sourceEventIds ?? [], "sourceEventIds");
      for (const eventId of sourceEventIds) {
        const event = this.#requireEvent(eventId);
        if (event.sessionId !== line.sessionId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Conversation node source event "${event.id}" must belong to session "${line.sessionId}".`
          );
        }
      }
      const sourceTaskIds = uniqueIds(input.sourceTaskIds ?? [], "sourceTaskIds");
      for (const taskId of sourceTaskIds) {
        const task = this.#requireTask(taskId);
        if (task.sessionId !== line.sessionId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Conversation node source task "${task.id}" must belong to session "${line.sessionId}".`
          );
        }
      }
      const sourceResultIds = uniqueIds(input.sourceResultIds ?? [], "sourceResultIds");
      for (const resultId of sourceResultIds) {
        const result = this.#requireBranchResult(resultId);
        if (result.sessionId !== line.sessionId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Conversation node source result "${result.id}" must belong to session "${line.sessionId}".`
          );
        }
      }

      const nodeId = input.id ?? `conversation-node-${randomUUID()}`;
      if (this.#getNode(nodeId) !== undefined) {
        throw new ConversationStoreError("conflict", `Conversation node "${nodeId}" already exists.`);
      }
      const nextSequence = (
        this.#db
          .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM conversation_nodes WHERE line_id = ?")
          .get(line.id) as { readonly sequence: number }
      ).sequence;
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#db
        .prepare(`
          INSERT INTO conversation_nodes (
            id,
            session_id,
            line_id,
            sequence,
            parent_ids_json,
            kind,
            title,
            state_patch_json,
            source_event_ids_json,
            source_task_ids_json,
            source_result_ids_json,
            created_by,
            create_request_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          nodeId,
          line.sessionId,
          line.id,
          nextSequence,
          encodeRequiredJson(uniqueParentIds, "conversation node parent ids"),
          input.kind,
          input.title,
          encodeRequiredJson(input.statePatch, "conversation node state patch"),
          encodeRequiredJson(sourceEventIds, "conversation node source event ids"),
          encodeRequiredJson(sourceTaskIds, "conversation node source task ids"),
          encodeRequiredJson(sourceResultIds, "conversation node source result ids"),
          input.createdBy,
          input.idempotencyKey,
          createdAt
        );
      this.#db
        .prepare(`
          INSERT INTO conversation_line_heads (line_id, node_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(line_id) DO UPDATE SET
            node_id = excluded.node_id,
            updated_at = excluded.updated_at
        `)
        .run(line.id, nodeId, createdAt);
      return this.#requireNode(nodeId);
    });
  }

  async getNode(nodeId: string): Promise<ConversationNode | undefined> {
    validateId(nodeId, "conversation node id");
    return this.#getNode(nodeId);
  }

  async listNodes(lineId: string, options: ListConversationNodesOptions = {}): Promise<readonly ConversationNode[]> {
    validateId(lineId, "line id");
    validateListConversationNodesOptions(options);
    this.#requireLine(lineId);
    const clauses = ["line_id = ?"];
    const parameters: unknown[] = [lineId];
    if (options.afterOrdinal !== undefined) {
      clauses.push("ordinal > ?");
      parameters.push(options.afterOrdinal);
    }
    if (options.beforeOrdinal !== undefined) {
      clauses.push("ordinal < ?");
      parameters.push(options.beforeOrdinal);
    }
    if (options.kinds !== undefined && options.kinds.length > 0) {
      clauses.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      parameters.push(...options.kinds);
    }
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) {
      parameters.push(options.limit);
    }
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM (
          SELECT *
          FROM conversation_nodes
          WHERE ${clauses.join(" AND ")}
          ORDER BY ordinal DESC
          ${limit}
        )
        ORDER BY ordinal
      `)
      .all(...parameters) as NodeRow[];
    return rows.map((row) => this.#nodeFromRow(row));
  }

  async getLineHead(lineId: string): Promise<ConversationLineHead | undefined> {
    validateId(lineId, "line id");
    this.#requireLine(lineId);
    return this.#getLineHead(lineId);
  }

  async createContextSnapshot(
    lineId: string,
    input: CreateConversationContextSnapshotInput
  ): Promise<ConversationContextSnapshot> {
    validateId(lineId, "line id");
    validateIdempotencyKey(input.idempotencyKey);

    return this.#write(() => {
      const line = this.#requireLine(lineId);
      const currentHead = this.#getLineHead(line.id);
      const nodeId = input.nodeId ?? currentHead?.nodeId;
      if (nodeId === undefined) {
        throw new ConversationStoreError("validation_error", `Line "${line.id}" has no semantic node to snapshot.`);
      }
      const existingRow = this.#db
        .prepare("SELECT * FROM conversation_context_snapshots WHERE line_id = ? AND create_request_id = ? LIMIT 1")
        .get(line.id, input.idempotencyKey) as SnapshotRow | undefined;
      if (existingRow !== undefined) {
        const existing = this.#snapshotFromRow(existingRow);
        if (
          existing.nodeId !== nodeId ||
          existing.id !== (input.id ?? existing.id) ||
          existing.createdAt !== (input.createdAt ?? existing.createdAt)
        ) {
          throw new ConversationStoreError(
            "idempotency_conflict",
            `Idempotency key "${input.idempotencyKey}" was already used for a different context snapshot request.`
          );
        }
        return existing;
      }

      const node = this.#requireNode(nodeId);
      if (node.sessionId !== line.sessionId || node.lineId !== line.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Snapshot node "${node.id}" must belong to line "${line.id}".`
        );
      }
      const reconstructed = this.#reconstructLineState(line.id, node.id);
      const snapshotId = input.id ?? `conversation-snapshot-${randomUUID()}`;
      if (this.#db.prepare("SELECT 1 FROM conversation_context_snapshots WHERE id = ?").get(snapshotId) !== undefined) {
        throw new ConversationStoreError("conflict", `Conversation context snapshot "${snapshotId}" already exists.`);
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#db
        .prepare(`
          INSERT INTO conversation_context_snapshots (
            id,
            session_id,
            line_id,
            node_id,
            node_ordinal,
            state_json,
            create_request_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          snapshotId,
          line.sessionId,
          line.id,
          node.id,
          node.ordinal,
          encodeRequiredJson(reconstructed.state, "conversation context snapshot state"),
          input.idempotencyKey,
          createdAt
        );
      return this.#requireSnapshot(snapshotId);
    });
  }

  async getLatestContextSnapshot(lineId: string): Promise<ConversationContextSnapshot | undefined> {
    validateId(lineId, "line id");
    this.#requireLine(lineId);
    const row = this.#db
      .prepare(`
        SELECT *
        FROM conversation_context_snapshots
        WHERE line_id = ?
        ORDER BY node_ordinal DESC, rowid DESC
        LIMIT 1
      `)
      .get(lineId) as SnapshotRow | undefined;
    return row === undefined ? undefined : this.#snapshotFromRow(row);
  }

  async reconstructLineState(lineId: string, headNodeId?: string): Promise<ReconstructedConversationState> {
    validateId(lineId, "line id");
    if (headNodeId !== undefined) {
      validateId(headNodeId, "conversation node id");
    }
    return this.#reconstructLineState(lineId, headNodeId);
  }

  #getNode(nodeId: string): ConversationNode | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_nodes WHERE id = ? LIMIT 1").get(nodeId) as
      | NodeRow
      | undefined;
    return row === undefined ? undefined : this.#nodeFromRow(row);
  }

  #requireNode(nodeId: string): ConversationNode {
    const node = this.#getNode(nodeId);
    if (node === undefined) {
      throw new ConversationStoreError("not_found", `Conversation node "${nodeId}" does not exist.`);
    }
    return node;
  }

  #nodeFromRow(row: NodeRow): ConversationNode {
    return {
      id: row.id,
      ordinal: row.ordinal,
      sequence: row.sequence,
      sessionId: row.session_id,
      lineId: row.line_id,
      parentIds: decodeJson<readonly string[]>(row.parent_ids_json, "conversation node parent ids"),
      kind: row.kind,
      title: row.title,
      statePatch: decodeJson<ConversationNode["statePatch"]>(row.state_patch_json, "conversation node state patch"),
      sourceEventIds: decodeJson<readonly string[]>(row.source_event_ids_json, "conversation node source event ids"),
      sourceTaskIds: decodeJson<readonly string[]>(row.source_task_ids_json, "conversation node source task ids"),
      sourceResultIds: decodeJson<readonly string[]>(row.source_result_ids_json, "conversation node source result ids"),
      createdBy: row.created_by,
      idempotencyKey: row.create_request_id,
      createdAt: row.created_at
    };
  }

  #getLineHead(lineId: string): ConversationLineHead | undefined {
    const row = this.#db
      .prepare("SELECT line_id, node_id, updated_at FROM conversation_line_heads WHERE line_id = ? LIMIT 1")
      .get(lineId) as
      | {
          readonly line_id: string;
          readonly node_id: string;
          readonly updated_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          lineId: row.line_id,
          nodeId: row.node_id,
          updatedAt: row.updated_at
        };
  }

  #snapshotFromRow(row: SnapshotRow): ConversationContextSnapshot {
    return {
      id: row.id,
      sessionId: row.session_id,
      lineId: row.line_id,
      nodeId: row.node_id,
      nodeOrdinal: row.node_ordinal,
      state: decodeJson<Readonly<Record<string, unknown>>>(row.state_json, "conversation context snapshot state"),
      idempotencyKey: row.create_request_id,
      createdAt: row.created_at
    };
  }

  #requireSnapshot(snapshotId: string): ConversationContextSnapshot {
    const row = this.#db
      .prepare("SELECT * FROM conversation_context_snapshots WHERE id = ? LIMIT 1")
      .get(snapshotId) as SnapshotRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Conversation context snapshot "${snapshotId}" does not exist.`);
    }
    return this.#snapshotFromRow(row);
  }

  #reconstructLineState(lineId: string, headNodeId?: string): ReconstructedConversationState {
    const line = this.#requireLine(lineId);
    const resolvedHeadId = headNodeId ?? this.#getLineHead(line.id)?.nodeId;
    if (resolvedHeadId === undefined) {
      return {
        sessionId: line.sessionId,
        lineId: line.id,
        state: {},
        appliedNodeIds: []
      };
    }
    const head = this.#requireNode(resolvedHeadId);
    if (head.lineId !== line.id) {
      throw new ConversationStoreError(
        "ownership_mismatch",
        `Conversation node "${head.id}" is not a head candidate for line "${line.id}".`
      );
    }

    const ancestry = this.#collectNodeAncestry(head);
    const ancestryIds = new Set(ancestry.map((node) => node.id));
    const snapshotRows = this.#db
      .prepare(`
        SELECT *
        FROM conversation_context_snapshots
        WHERE session_id = ?
        ORDER BY node_ordinal DESC, rowid DESC
      `)
      .all(line.sessionId) as SnapshotRow[];
    const snapshotRow = snapshotRows.find((candidate) => ancestryIds.has(candidate.node_id));
    const snapshot = snapshotRow === undefined ? undefined : this.#snapshotFromRow(snapshotRow);
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
        visit(this.#requireNode(parentId));
      }
      visited.add(node.id);
    };
    visit(head);
    return [...visited].map((nodeId) => this.#requireNode(nodeId)).sort((left, right) => left.ordinal - right.ordinal);
  }

  #assertNodeRetry(existing: ConversationNode, input: CreateConversationNodeInput): void {
    if (
      existing.id !== (input.id ?? existing.id) ||
      (input.parentIds !== undefined && !jsonValuesEqual(existing.parentIds, input.parentIds)) ||
      existing.kind !== input.kind ||
      existing.title !== input.title ||
      !jsonValuesEqual(existing.statePatch, input.statePatch) ||
      !jsonValuesEqual(existing.sourceEventIds, input.sourceEventIds ?? []) ||
      !jsonValuesEqual(existing.sourceTaskIds, input.sourceTaskIds ?? []) ||
      !jsonValuesEqual(existing.sourceResultIds, input.sourceResultIds ?? []) ||
      existing.createdBy !== input.createdBy ||
      existing.createdAt !== (input.createdAt ?? existing.createdAt)
    ) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Idempotency key "${input.idempotencyKey}" was already used for a different conversation node request.`
      );
    }
  }

  #getTask(taskId: string): ConversationTask | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_tasks WHERE id = ? LIMIT 1").get(taskId) as
      | TaskRow
      | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  #requireTask(taskId: string): ConversationTask {
    const task = this.#getTask(taskId);
    if (task === undefined) {
      throw new ConversationStoreError("not_found", `Task "${taskId}" does not exist.`);
    }
    return task;
  }

  #assertTaskCreateRetry(existing: ConversationTask, input: CreateTaskInput): void {
    const created = this.#taskCreationSnapshot(existing);
    const mismatch =
      (input.id !== undefined && created.id !== input.id) ||
      created.executor !== input.executor ||
      created.workspaceId !== input.workspaceId ||
      !jsonValuesEqual(created.input, input.input) ||
      !jsonValuesEqual(created.artifacts, input.artifacts ?? []) ||
      created.sourceEventId !== input.sourceEventId ||
      (input.createdAt !== undefined && created.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Task creation request "${input.idempotencyKey}" conflicts with the stored task.`
      );
    }
  }

  #taskCreationSnapshot(task: ConversationTask): ConversationTask {
    const event = this.#getEventByLineAndRequest(task.branchId, `internal:task-created:${task.id}`);
    const payload = eventPayloadRecord(event, "task creation");
    return {
      id: task.id,
      sessionId: task.sessionId,
      branchId: task.branchId,
      status: "pending",
      executor: task.executor,
      ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
      input: payload?.input ?? task.input,
      artifacts: Array.isArray(payload?.artifacts) ? payload.artifacts : [],
      idempotencyKey: task.idempotencyKey,
      ...(task.sourceEventId === undefined ? {} : { sourceEventId: task.sourceEventId }),
      createdAt: task.createdAt,
      updatedAt: task.createdAt
    };
  }

  #taskSnapshotAtEvent(task: ConversationTask, targetEvent: LineEvent): ConversationTask {
    let snapshot = this.#taskCreationSnapshot(task);
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM line_events
        WHERE task_id = ?
          AND ordinal <= ?
        ORDER BY ordinal
      `)
      .all(task.id, targetEvent.ordinal) as LineEventRow[];
    for (const row of rows) {
      const event = lineEventFromRow(row);
      if (event.type !== "task_status_changed") {
        continue;
      }
      const payload = eventPayloadRecord(event, "task transition");
      if (payload === undefined) {
        continue;
      }
      const status = payload?.toStatus;
      if (
        status !== "pending" &&
        status !== "running" &&
        status !== "blocked" &&
        status !== "completed" &&
        status !== "failed" &&
        status !== "cancelled"
      ) {
        continue;
      }
      snapshot = Object.assign(
        {},
        snapshot,
        { status, updatedAt: event.createdAt },
        Object.hasOwn(payload, "output") ? { output: payload.output } : {},
        Object.hasOwn(payload, "error") ? { error: payload.error } : {},
        Array.isArray(payload.artifacts) ? { artifacts: payload.artifacts } : {},
        status === "running" && snapshot.startedAt === undefined ? { startedAt: event.createdAt } : {},
        isTerminalTaskStatus(status) && snapshot.finishedAt === undefined ? { finishedAt: event.createdAt } : {}
      );
    }
    return snapshot;
  }

  #resultFromRow(row: ResultRow): BranchResult {
    const taskRows = this.#db
      .prepare(`
        SELECT task_id
        FROM branch_result_tasks
        WHERE result_id = ?
        ORDER BY rowid
      `)
      .all(row.id) as Array<{ readonly task_id: string }>;
    return {
      id: row.id,
      sessionId: row.session_id,
      branchId: row.branch_line_id,
      version: row.version,
      status: row.status,
      summary: row.summary,
      artifacts: decodeJson<readonly unknown[]>(row.artifacts_json, "branch result artifacts"),
      citations: decodeJson<readonly unknown[]>(row.citations_json, "branch result citations"),
      nextActions: decodeJson<readonly string[]>(row.next_actions_json, "branch result next actions"),
      sourceTaskIds: taskRows.map((task) => task.task_id),
      idempotencyKey: row.create_request_id,
      ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
      createdAt: row.created_at
    };
  }

  #requireBranchResult(resultId: string): BranchResult {
    const row = this.#db.prepare("SELECT * FROM branch_results WHERE id = ? LIMIT 1").get(resultId) as
      | ResultRow
      | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Branch result "${resultId}" does not exist.`);
    }
    return this.#resultFromRow(row);
  }

  #latestResult(branchId: string): BranchResult {
    const row = this.#db
      .prepare(`
        SELECT *
        FROM branch_results
        WHERE branch_line_id = ?
        ORDER BY version DESC
        LIMIT 1
      `)
      .get(branchId) as ResultRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Branch "${branchId}" has no result to merge.`);
    }
    return this.#resultFromRow(row);
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
    const rows = this.#db
      .prepare(`
        SELECT id
        FROM conversation_tasks
        WHERE branch_line_id = ?
          AND status IN ('pending', 'running', 'blocked')
        ORDER BY created_at, rowid
      `)
      .all(branchId) as Array<{ readonly id: string }>;
    if (rows.length !== 0) {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Branch "${branchId}" cannot ${action} while tasks are unfinished: ${rows.map((row) => row.id).join(", ")}.`
      );
    }
  }

  #assertSessionCanArchive(sessionId: string): void {
    const unfinishedTask = this.#db
      .prepare(`
        SELECT id
        FROM conversation_tasks
        WHERE session_id = ?
          AND status IN ('pending', 'running', 'blocked')
        LIMIT 1
      `)
      .get(sessionId);
    const openBranch = this.#db
      .prepare(`
        SELECT id
        FROM conversation_lines
        WHERE session_id = ?
          AND kind = 'branch'
          AND status NOT IN (${placeholders(SESSION_ARCHIVABLE_BRANCH_STATUSES.size)})
        LIMIT 1
      `)
      .get(sessionId, ...SESSION_ARCHIVABLE_BRANCH_STATUSES);
    if (unfinishedTask !== undefined || openBranch !== undefined) {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Session "${sessionId}" cannot be archived while branches or tasks are unfinished.`
      );
    }
  }

  #assertResultCreateRetry(existing: BranchResult, input: CreateBranchResultInput): void {
    const mismatch =
      (input.id !== undefined && existing.id !== input.id) ||
      (input.version !== undefined && existing.version !== input.version) ||
      existing.status !== input.status ||
      existing.summary !== input.summary ||
      !jsonValuesEqual(existing.artifacts, input.artifacts ?? []) ||
      !jsonValuesEqual(existing.citations, input.citations ?? []) ||
      !jsonValuesEqual(existing.nextActions, input.nextActions ?? []) ||
      !jsonValuesEqual(existing.sourceTaskIds, input.sourceTaskIds ?? []) ||
      existing.sourceEventId !== input.sourceEventId ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Branch result request "${input.idempotencyKey}" conflicts with the stored result.`
      );
    }
  }

  #requireMerge(mergeId: string): BranchMerge {
    const row = this.#db
      .prepare(`
        SELECT branch_merges.*, conversation_lines.session_id
        FROM branch_merges
        JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
        WHERE branch_merges.id = ?
        LIMIT 1
      `)
      .get(mergeId) as MergeRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Branch merge "${mergeId}" does not exist.`);
    }
    return mergeFromRow(row);
  }

  #assertMergeRetry(existing: BranchMerge, mainlineId: string, resultId: string, input: MergeBranchResultInput): void {
    const mismatch =
      existing.mainlineId !== mainlineId ||
      existing.resultId !== resultId ||
      (input.id !== undefined && existing.id !== input.id) ||
      (input.eventId !== undefined && existing.mainlineEventId !== input.eventId) ||
      (input.branchEventId !== undefined && existing.branchEventId !== input.branchEventId) ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Branch merge request "${existing.idempotencyKey}" conflicts with the stored merge.`
      );
    }
  }

  async getBranchContext(branchId: string): Promise<BranchContext> {
    validateId(branchId, "branch id");
    return this.#read(() => {
      const branch = this.#requireBranch(branchId);
      const session = this.#requireSession(branch.sessionId);
      const mainline = this.#requireMainline(session.id);
      const sourceEvent = this.#requireEvent(branch.sourceEventId);
      const events = this.#listAllEvents(branch.id);
      const taskRows = this.#db
        .prepare(`
          SELECT *
          FROM conversation_tasks
          WHERE branch_line_id = ?
          ORDER BY created_at, rowid
        `)
        .all(branch.id) as TaskRow[];
      const resultRows = this.#db
        .prepare(`
          SELECT *
          FROM branch_results
          WHERE branch_line_id = ?
          ORDER BY version, rowid
        `)
        .all(branch.id) as ResultRow[];
      return {
        session,
        mainline,
        branch,
        sourceEvent,
        ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot }),
        events,
        tasks: taskRows.map(taskFromRow),
        results: resultRows.map((row) => this.#resultFromRow(row))
      };
    });
  }

  async getRecoveryState(sessionId?: string): Promise<ConversationRecoveryState> {
    if (sessionId !== undefined) {
      validateId(sessionId, "session id");
    }
    return this.#read(() => {
      if (sessionId !== undefined) {
        this.#requireSession(sessionId);
      }
      const filter = sessionId === undefined ? "" : " AND id = ?";
      const sessionRows = this.#db
        .prepare(`
          SELECT *
          FROM conversation_sessions
          WHERE status = 'active'
          ${filter}
          ORDER BY created_at, rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as SessionRow[];
      const sessions = sessionRows.map(sessionFromRow);
      const mainlines = sessions.map((session) => this.#requireMainline(session.id));

      const branchRows = this.#db
        .prepare(`
          SELECT conversation_lines.*
          FROM conversation_lines
          JOIN conversation_sessions
            ON conversation_sessions.id = conversation_lines.session_id
          WHERE conversation_lines.kind = 'branch'
            AND conversation_lines.status IN ('created', 'active', 'blocked', 'inactive', 'completed')
            AND conversation_sessions.status = 'active'
            ${sessionId === undefined ? "" : " AND conversation_lines.session_id = ?"}
          ORDER BY conversation_lines.created_at, conversation_lines.rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as LineRow[];
      const taskRows = this.#db
        .prepare(`
          SELECT conversation_tasks.*
          FROM conversation_tasks
          JOIN conversation_sessions
            ON conversation_sessions.id = conversation_tasks.session_id
          WHERE conversation_tasks.status IN ('pending', 'running', 'blocked')
            AND conversation_sessions.status = 'active'
            ${sessionId === undefined ? "" : " AND conversation_tasks.session_id = ?"}
          ORDER BY conversation_tasks.created_at, conversation_tasks.rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as TaskRow[];
      const resultRows = this.#db
        .prepare(`
          SELECT branch_results.*
          FROM branch_results
          JOIN conversation_sessions
            ON conversation_sessions.id = branch_results.session_id
          JOIN conversation_lines
            ON conversation_lines.id = branch_results.branch_line_id
          LEFT JOIN branch_merges ON branch_merges.result_id = branch_results.id
          WHERE branch_merges.id IS NULL
            AND branch_results.status = 'completed'
            AND conversation_lines.status NOT IN ('failed', 'cancelled')
            AND conversation_sessions.status = 'active'
            ${sessionId === undefined ? "" : " AND branch_results.session_id = ?"}
          ORDER BY branch_results.created_at, branch_results.rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as ResultRow[];
      return {
        sessions,
        mainlines,
        activeBranches: branchRows.map(requireBranchFromRow),
        unfinishedTasks: taskRows.map(taskFromRow),
        unmergedResults: resultRows.map((row) => this.#resultFromRow(row))
      };
    });
  }

  async getTaskTrace(taskId: string): Promise<TaskTrace> {
    validateId(taskId, "task id");
    return this.#read(() => {
      const task = this.#requireTask(taskId);
      const branch = this.#requireBranch(task.branchId);
      const session = this.#requireSession(task.sessionId);
      const mainline = this.#requireMainline(session.id);
      const sourceEvent = task.sourceEventId === undefined ? undefined : this.#requireEvent(task.sourceEventId);
      const branchSourceEvent = this.#requireEvent(branch.sourceEventId);
      const eventRows = this.#db
        .prepare(`
          SELECT *
          FROM line_events
          WHERE session_id = ?
          ORDER BY ordinal
        `)
        .all(task.sessionId) as LineEventRow[];
      const events = eventRows
        .map(lineEventFromRow)
        .filter(
          (event) =>
            event.taskId === task.id || (event.payload !== undefined && payloadContainsTaskId(event.payload, task.id))
        );
      const resultRows = this.#db
        .prepare(`
          SELECT branch_results.*
          FROM branch_results
          JOIN branch_result_tasks
            ON branch_result_tasks.result_id = branch_results.id
          WHERE branch_result_tasks.task_id = ?
          ORDER BY branch_results.created_at, branch_results.rowid
        `)
        .all(task.id) as ResultRow[];
      return {
        task,
        branch,
        mainline,
        session,
        ...(sourceEvent === undefined ? {} : { sourceEvent }),
        branchSourceEvent,
        events,
        results: resultRows.map((row) => this.#resultFromRow(row))
      };
    });
  }

  async getEventTrace(eventId: string): Promise<EventTrace> {
    validateId(eventId, "line event id");
    return this.#read(() => {
      const event = this.#requireEvent(eventId);
      const line = this.#requireLine(event.lineId);
      const session = this.#requireSession(event.sessionId);
      const branch = line.kind === "branch" ? line : undefined;
      const task = event.taskId === undefined ? undefined : this.#requireTask(event.taskId);
      const sourceEvent = event.sourceEventId === undefined ? undefined : this.#getEvent(event.sourceEventId);
      const causationChain = this.#causationChain(event);
      const sessionEvents = (
        this.#db
          .prepare(`
          SELECT *
          FROM line_events
          WHERE session_id = ?
          ORDER BY ordinal
        `)
          .all(event.sessionId) as LineEventRow[]
      ).map(lineEventFromRow);
      return {
        event,
        line,
        session,
        ...(branch === undefined ? {} : { branch }),
        ...(task === undefined ? {} : { task }),
        ...(sourceEvent === undefined ? {} : { sourceEvent }),
        causationChain,
        relatedEvents: collectRelatedEvents(sessionEvents, event, causationChain)
      };
    });
  }

  async getBranchResultTrace(resultId: string): Promise<BranchResultTrace> {
    validateId(resultId, "branch result id");
    return this.#read(() => {
      const result = this.#requireBranchResult(resultId);
      const branch = this.#requireBranch(result.branchId);
      const session = this.#requireSession(result.sessionId);
      const mainline = this.#requireMainline(session.id);
      const sourceEvent = result.sourceEventId === undefined ? undefined : this.#requireEvent(result.sourceEventId);
      const tasks = result.sourceTaskIds.map((taskId) => this.#requireTask(taskId));
      const mergeRow = this.#db
        .prepare(`
          SELECT branch_merges.*, conversation_lines.session_id
          FROM branch_merges
          JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
          WHERE branch_merges.result_id = ?
          ORDER BY branch_merges.rowid
          LIMIT 1
        `)
        .get(result.id) as MergeRow | undefined;
      const merge = mergeRow === undefined ? undefined : mergeFromRow(mergeRow);
      const mainlineEvent = merge === undefined ? undefined : this.#requireEvent(merge.mainlineEventId);
      return {
        result,
        branch,
        mainline,
        session,
        ...(sourceEvent === undefined ? {} : { sourceEvent }),
        tasks,
        ...(merge === undefined ? {} : { publication: merge, merge }),
        ...(mainlineEvent === undefined ? {} : { mainlineEvent })
      };
    });
  }

  #listAllEvents(lineId: string): readonly LineEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM line_events WHERE line_id = ? ORDER BY sequence")
      .all(lineId) as LineEventRow[];
    return rows.map(lineEventFromRow);
  }

  #causationChain(event: LineEvent): readonly LineEvent[] {
    const result: LineEvent[] = [];
    const visited = new Set<string>([event.id]);
    let cursor = event.causationEventId ?? event.sourceEventId;
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      const ancestor = this.#getEvent(cursor);
      if (ancestor === undefined) {
        break;
      }
      result.unshift(ancestor);
      cursor = ancestor.causationEventId ?? ancestor.sourceEventId;
    }
    result.push(event);
    return result;
  }

  #read<T>(operation: () => T): T {
    return this.#db.transaction(operation).deferred();
  }

  #createOrEnsureSession(input: CreateSessionInput, ensure: boolean): ConversationSession {
    const requestedId = resolveSessionId(input);
    if (input.idempotencyKey !== undefined) {
      const idempotentRow = this.#db
        .prepare("SELECT * FROM conversation_sessions WHERE idempotency_key = ? ORDER BY rowid LIMIT 1")
        .get(input.idempotencyKey) as SessionRow | undefined;
      if (idempotentRow !== undefined) {
        const existing = sessionFromRow(idempotentRow);
        this.#assertSessionMatchesInput(existing, input, true);
        return existing;
      }
    }

    if (requestedId !== undefined) {
      const existing = this.#getSession(requestedId);
      if (existing !== undefined) {
        if (!ensure) {
          throw new ConversationStoreError("conflict", `Session "${requestedId}" already exists.`);
        }
        this.#assertSessionMatchesInput(existing, input, false);
        return existing;
      }
    }

    if (input.locator !== undefined) {
      const located = this.#findSessionByLocator(input.locator);
      if (located !== undefined) {
        if (!ensure) {
          throw new ConversationStoreError(
            "conflict",
            `A session already exists for conversation "${input.locator.conversationId}".`
          );
        }
        if (requestedId !== undefined && located.id !== requestedId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Conversation "${input.locator.conversationId}" belongs to session "${located.id}", not "${requestedId}".`
          );
        }
        this.#assertSessionMatchesInput(located, input, false);
        return located;
      }
    }

    const id = requestedId ?? `session:${randomUUID()}`;
    const mainlineId = input.mainlineId ?? `mainline:${id}`;
    if (this.#getLine(mainlineId) !== undefined) {
      throw new ConversationStoreError("conflict", `Line "${mainlineId}" already exists.`);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const locator = input.locator;
    this.#db
      .prepare(`
        INSERT INTO conversation_sessions (
          id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          status,
          mainline_id,
          workspace_id,
          metadata_json,
          idempotency_key,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        locator?.platform ?? null,
        locator?.provider ?? null,
        locator?.channelId ?? null,
        locator?.conversationType ?? null,
        locator?.conversationId ?? null,
        mainlineId,
        input.workspaceId ?? null,
        encodeOptionalJson(input.metadata, "session metadata"),
        input.idempotencyKey ?? null,
        createdAt,
        createdAt
      );
    this.#db
      .prepare(`
        INSERT INTO conversation_lines (
          id,
          session_id,
          kind,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, 'mainline', 'active', ?, ?)
      `)
      .run(mainlineId, id, createdAt, createdAt);
    return this.#requireSession(id);
  }

  #assertSessionMatchesInput(existing: ConversationSession, input: CreateSessionInput, exact: boolean): void {
    const requestedId = resolveSessionId(input);
    const mismatch =
      (requestedId !== undefined && existing.id !== requestedId) ||
      (input.mainlineId !== undefined && existing.mainlineId !== input.mainlineId) ||
      (input.locator !== undefined &&
        (exact || existing.locator !== undefined) &&
        !locatorsEqual(existing.locator, input.locator)) ||
      (exact && input.locator === undefined && existing.locator !== undefined) ||
      (input.workspaceId !== undefined && existing.workspaceId !== input.workspaceId) ||
      (exact && input.workspaceId === undefined && existing.workspaceId !== undefined) ||
      (exact && input.metadata !== undefined && !jsonValuesEqual(existing.metadata, input.metadata)) ||
      (exact && input.metadata === undefined && existing.metadata !== undefined) ||
      (exact && input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        input.idempotencyKey === undefined ? "conflict" : "idempotency_conflict",
        `Session request "${input.idempotencyKey ?? existing.id}" conflicts with the stored session.`
      );
    }
  }

  #findSessionByLocator(locator: ConversationSessionLocator): ConversationSession | undefined {
    const row = this.#db
      .prepare(`
        SELECT *
        FROM conversation_sessions
        WHERE platform = ?
          AND provider = ?
          AND channel_id = ?
          AND conversation_type = ?
          AND conversation_id = ?
        LIMIT 1
      `)
      .get(locator.platform, locator.provider, locator.channelId, locator.conversationType, locator.conversationId) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  #getSession(sessionId: string): ConversationSession | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_sessions WHERE id = ? LIMIT 1").get(sessionId) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  #requireSession(sessionId: string): ConversationSession {
    const session = this.#getSession(sessionId);
    if (session === undefined) {
      throw new ConversationStoreError("not_found", `Session "${sessionId}" does not exist.`);
    }
    return session;
  }

  #getLine(lineId: string): ConversationLine | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_lines WHERE id = ? LIMIT 1").get(lineId) as
      | LineRow
      | undefined;
    return row === undefined ? undefined : lineFromRow(row);
  }

  #requireLine(lineId: string): ConversationLine {
    const line = this.#getLine(lineId);
    if (line === undefined) {
      throw new ConversationStoreError("not_found", `Line "${lineId}" does not exist.`);
    }
    return line;
  }

  #requireMainline(sessionId: string): ConversationMainline {
    const row = this.#db
      .prepare("SELECT * FROM conversation_lines WHERE session_id = ? AND kind = 'mainline' LIMIT 1")
      .get(sessionId) as LineRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Session "${sessionId}" has no mainline.`);
    }
    const line = lineFromRow(row);
    if (line.kind !== "mainline") {
      throw new ConversationStoreError("conflict", `Session "${sessionId}" has an invalid mainline.`);
    }
    return line;
  }

  #getNormalizedEvent(eventId: string): NormalizedEvent | undefined {
    const row = this.#db
      .prepare(`
        SELECT
          normalized_events.*,
          line_events.line_id,
          line_events.id AS line_event_id
        FROM normalized_events
        JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.id = ?
        LIMIT 1
      `)
      .get(eventId) as NormalizedEventRow | undefined;
    return row === undefined ? undefined : normalizedEventFromRow(row);
  }

  #requireNormalizedEvent(eventId: string): NormalizedEvent {
    const event = this.#getNormalizedEvent(eventId);
    if (event === undefined) {
      throw new ConversationStoreError("not_found", `Normalized event "${eventId}" does not exist.`);
    }
    return event;
  }

  #getNormalizedEventByIdempotencyKey(idempotencyKey: string): NormalizedEvent | undefined {
    const row = this.#db
      .prepare(`
        SELECT
          normalized_events.*,
          line_events.line_id,
          line_events.id AS line_event_id
        FROM normalized_events
        JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.idempotency_key = ?
        LIMIT 1
      `)
      .get(idempotencyKey) as NormalizedEventRow | undefined;
    return row === undefined ? undefined : normalizedEventFromRow(row);
  }

  #assertNormalizedEventRetry(
    existing: NormalizedEvent,
    input: AcceptNormalizedEventInput,
    segments: readonly unknown[]
  ): void {
    const lineEvent = this.#requireEvent(existing.lineEventId);
    const expectedLineEventType = input.lineEventType ?? "user_message";
    const expectedPayload = {
      normalizedEventId: existing.id,
      text: input.text,
      ...(input.message === undefined ? {} : { message: input.message }),
      segments,
      ...(input.triggerHint === undefined ? {} : { triggerHint: input.triggerHint })
    };
    const mismatch =
      (input.id !== undefined && existing.id !== input.id) ||
      (input.lineEventId !== undefined && existing.lineEventId !== input.lineEventId) ||
      (input.targetLineId !== undefined && existing.lineId !== input.targetLineId) ||
      existing.sessionId !== input.sessionId ||
      existing.platform !== input.platform ||
      existing.provider !== input.provider ||
      existing.channelId !== input.channelId ||
      existing.conversationType !== input.conversationType ||
      existing.conversationId !== input.conversationId ||
      existing.sourceEventId !== input.sourceEventId ||
      existing.sourceMessageId !== input.sourceMessageId ||
      existing.sourceEventType !== input.sourceEventType ||
      existing.senderId !== input.senderId ||
      existing.text !== input.text ||
      !jsonValuesEqual(existing.message, input.message) ||
      !jsonValuesEqual(existing.segments, segments) ||
      !jsonValuesEqual(existing.triggerHint, input.triggerHint) ||
      !jsonValuesEqual(existing.rawPayload, input.rawPayload) ||
      existing.receivedAt !== input.receivedAt ||
      lineEvent.type !== expectedLineEventType ||
      lineEvent.idempotencyKey !== `normalized:${input.idempotencyKey}` ||
      lineEvent.actorId !== input.actorId ||
      !jsonValuesEqual(lineEvent.payload, expectedPayload);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Normalized event request "${input.idempotencyKey}" conflicts with the stored event.`
      );
    }
  }

  #assertUnusedNormalizedEventId(eventId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM normalized_events WHERE id = ?").get(eventId);
    if (row !== undefined) {
      throw new ConversationStoreError("conflict", `Normalized event "${eventId}" already exists.`);
    }
  }

  #assertUnusedLineEventId(eventId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM line_events WHERE id = ?").get(eventId);
    if (row !== undefined) {
      throw new ConversationStoreError("conflict", `Line event "${eventId}" already exists.`);
    }
  }

  #write<T>(operation: () => T): T {
    try {
      return this.#db.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof ConversationStoreError) {
        throw error;
      }
      if (isSqliteConstraintError(error)) {
        throw new ConversationStoreError("conflict", `Conversation persistence conflict: ${error.message}`);
      }
      throw error;
    }
  }
}

function sessionFromRow(row: SessionRow): ConversationSession {
  const locator =
    row.platform === null ||
    row.provider === null ||
    row.channel_id === null ||
    row.conversation_type === null ||
    row.conversation_id === null
      ? undefined
      : {
          platform: row.platform,
          provider: row.provider,
          channelId: row.channel_id,
          conversationType: row.conversation_type,
          conversationId: row.conversation_id
        };
  return {
    id: row.id,
    mainlineId: row.mainline_id,
    status: row.status,
    ...(locator === undefined ? {} : { locator }),
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    ...(row.metadata_json === null ? {} : { metadata: decodeJson(row.metadata_json, "session metadata") }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function lineFromRow(row: LineRow): ConversationLine {
  if (row.kind === "mainline") {
    if (row.status !== "active" && row.status !== "archived") {
      throw new ConversationStoreError("conflict", `Mainline "${row.id}" has invalid status "${row.status}".`);
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: "mainline",
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  if (
    row.parent_mainline_id === null ||
    row.source_line_event_id === null ||
    row.title === null ||
    row.goal === null ||
    row.reason === null ||
    row.created_by === null ||
    row.create_request_id === null
  ) {
    throw new ConversationStoreError("conflict", `Branch "${row.id}" is missing required persisted fields.`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: "branch",
    parentMainlineId: row.parent_mainline_id,
    sourceEventId: row.source_line_event_id,
    title: row.title,
    goal: row.goal,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    idempotencyKey: row.create_request_id,
    ...(row.context_snapshot_json === null
      ? {}
      : { contextSnapshot: decodeJson(row.context_snapshot_json, "branch context snapshot") }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.merged_at === null ? {} : { mergedAt: row.merged_at }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at })
  };
}

function normalizedEventFromRow(row: NormalizedEventRow): NormalizedEvent {
  const segments =
    row.segments_json === null
      ? []
      : decodeJson<NormalizedEvent["segments"]>(row.segments_json, "normalized event segments");
  return {
    id: row.id,
    sessionId: row.session_id,
    lineId: row.line_id,
    lineEventId: row.line_event_id,
    platform: row.platform,
    provider: row.provider,
    channelId: row.channel_id,
    conversationType: row.conversation_type,
    conversationId: row.conversation_id,
    sourceEventId: row.source_event_id,
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    sourceEventType: row.source_event_type,
    senderId: row.sender_id,
    text: row.text,
    ...(row.message_json === null
      ? {}
      : { message: decodeJson<NonNullable<NormalizedEvent["message"]>>(row.message_json, "normalized event message") }),
    segments,
    ...(row.trigger_hint_json === null
      ? {}
      : {
          triggerHint: decodeJson<NonNullable<NormalizedEvent["triggerHint"]>>(
            row.trigger_hint_json,
            "normalized event trigger hint"
          )
        }),
    ...(row.raw_payload_json === null
      ? {}
      : { rawPayload: decodeJson(row.raw_payload_json, "normalized event raw payload") }),
    receivedAt: row.received_at,
    idempotencyKey: row.idempotency_key,
    acceptedAt: row.ingested_at
  };
}

function lineEventFromRow(row: LineEventRow): LineEvent {
  return {
    id: row.id,
    ordinal: row.ordinal,
    sequence: row.sequence,
    sessionId: row.session_id,
    lineId: row.line_id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    ...(row.source_normalized_event_id === null ? {} : { sourceNormalizedEventId: row.source_normalized_event_id }),
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.causation_event_id === null ? {} : { causationEventId: row.causation_event_id }),
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    ...(row.payload_json === null ? {} : { payload: decodeJson(row.payload_json, "line event payload") }),
    createdAt: row.created_at
  };
}

function taskFromRow(row: TaskRow): ConversationTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_line_id,
    status: row.status,
    executor: row.executor,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    input: decodeJson(row.input_json, "task input"),
    ...(row.output_json === null ? {} : { output: decodeJson(row.output_json, "task output") }),
    ...(row.error_json === null ? {} : { error: decodeJson(row.error_json, "task error") }),
    artifacts: decodeJson<readonly unknown[]>(row.artifacts_json, "task artifacts"),
    idempotencyKey: row.create_request_id,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at })
  };
}

function mergeFromRow(row: MergeRow): BranchMerge {
  return {
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_line_id,
    resultId: row.result_id,
    mainlineId: row.mainline_id,
    mainlineEventId: row.mainline_event_id,
    branchEventId: row.branch_event_id,
    idempotencyKey: row.create_request_id,
    createdAt: row.merged_at
  };
}

function requireBranchFromRow(row: LineRow): ConversationBranch {
  const line = lineFromRow(row);
  if (line.kind !== "branch") {
    throw new ConversationStoreError("conflict", `Line "${line.id}" is not a branch.`);
  }
  return line;
}

function branchCreationSnapshot(branch: ConversationBranch): ConversationBranch {
  return {
    id: branch.id,
    sessionId: branch.sessionId,
    kind: "branch",
    parentMainlineId: branch.parentMainlineId,
    sourceEventId: branch.sourceEventId,
    title: branch.title,
    goal: branch.goal,
    reason: branch.reason,
    status: "created",
    createdBy: branch.createdBy,
    idempotencyKey: branch.idempotencyKey,
    ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot }),
    createdAt: branch.createdAt,
    updatedAt: branch.createdAt
  };
}

function branchSnapshotAtTransition(
  branch: ConversationBranch,
  status: ConversationBranch["status"],
  at: string
): ConversationBranch {
  const initial = branchCreationSnapshot(branch);
  return {
    ...initial,
    status,
    updatedAt: at,
    ...(status === "completed" ? { completedAt: at } : {}),
    ...(status === "merged" ? { mergedAt: at } : {}),
    ...(status === "archived" ? { archivedAt: at } : {})
  };
}

function branchResultPayload(branch: ConversationBranch, result: BranchResult): unknown {
  return {
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
  };
}

function eventPayloadRecord(event: LineEvent | undefined, operation: string): Record<string, unknown> | undefined {
  if (event === undefined) {
    return undefined;
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new ConversationStoreError("conflict", `Stored ${operation} event has an invalid payload.`);
  }
  return event.payload as Record<string, unknown>;
}

function assertTransitionEventRequest(
  event: LineEvent,
  type: LineEventType,
  targetStatus: string,
  detail: unknown,
  createdAt: string | undefined
): void {
  const payload = eventPayloadRecord(event, "transition");
  const storedDetail = payload !== undefined && Object.hasOwn(payload, "detail") ? payload.detail : undefined;
  if (
    event.type !== type ||
    payload?.toStatus !== targetStatus ||
    !jsonValuesEqual(storedDetail, detail) ||
    (createdAt !== undefined && event.createdAt !== createdAt)
  ) {
    throw new ConversationStoreError(
      "idempotency_conflict",
      `Transition request "${event.idempotencyKey}" conflicts with the stored event.`
    );
  }
}

function assertTaskTransitionEventRequest(event: LineEvent, input: TransitionTaskInput): void {
  const payload = eventPayloadRecord(event, "task transition");
  const storedOutput = payload !== undefined && Object.hasOwn(payload, "output") ? payload.output : undefined;
  const storedError = payload !== undefined && Object.hasOwn(payload, "error") ? payload.error : undefined;
  const storedArtifacts = payload !== undefined && Object.hasOwn(payload, "artifacts") ? payload.artifacts : undefined;
  if (
    event.type !== "task_status_changed" ||
    payload?.toStatus !== input.status ||
    !jsonValuesEqual(storedOutput, input.output) ||
    !jsonValuesEqual(storedError, input.error) ||
    !jsonValuesEqual(storedArtifacts, input.artifacts) ||
    (input.createdAt !== undefined && event.createdAt !== input.createdAt)
  ) {
    throw new ConversationStoreError(
      "idempotency_conflict",
      `Task transition request "${input.idempotencyKey}" conflicts with the stored event.`
    );
  }
}

function roleFromEventType(type: LineEventType): "user" | "assistant" | "system" | null {
  if (type === "user_message") {
    return "user";
  }
  if (type === "assistant_message") {
    return "assistant";
  }
  if (type === "system_message") {
    return "system";
  }
  return null;
}

function textFromPayload(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "text" in payload &&
    typeof (payload as { readonly text?: unknown }).text === "string"
  ) {
    return (payload as { readonly text: string }).text;
  }
  return null;
}

function validateCreateSessionInput(input: CreateSessionInput): void {
  if (input.id !== undefined) {
    validateId(input.id, "session id");
  }
  if (input.sessionId !== undefined) {
    validateId(input.sessionId, "session id");
  }
  if (input.id !== undefined && input.sessionId !== undefined && input.id !== input.sessionId) {
    throw new ConversationStoreError("validation_error", "Session id aliases must have the same value.");
  }
  if (input.id === undefined && input.sessionId === undefined) {
    throw new ConversationStoreError("validation_error", "createSession requires a non-empty id or sessionId.");
  }
  if (input.mainlineId !== undefined) {
    validateId(input.mainlineId, "mainline id");
  }
  if (input.idempotencyKey !== undefined) {
    validateId(input.idempotencyKey, "idempotency key");
  }
  if (input.workspaceId !== undefined) {
    validateId(input.workspaceId, "workspace id");
  }
  validateTimestamp(input.createdAt, "createdAt");
  if (input.locator !== undefined) {
    validateLocator(input.locator);
  }
}

function validateNormalizedEventInput(input: AcceptNormalizedEventInput): void {
  validateId(input.sessionId, "session id");
  validateId(input.idempotencyKey, "idempotency key");
  validateId(input.platform, "platform");
  validateId(input.provider, "provider");
  validateId(input.channelId, "channel id");
  validateId(input.conversationId, "conversation id");
  validateId(input.sourceEventId, "source event id");
  validateId(input.sourceEventType, "source event type");
  validateId(input.senderId, "sender id");
  validateTimestamp(input.receivedAt, "receivedAt", true);
  if (!LOCATOR_TYPES.has(input.conversationType)) {
    throw new ConversationStoreError("validation_error", `Unsupported conversation type "${input.conversationType}".`);
  }
  for (const [value, label] of [
    [input.id, "normalized event id"],
    [input.lineEventId, "line event id"],
    [input.targetLineId, "target line id"],
    [input.sourceMessageId, "source message id"],
    [input.actorId, "actor id"],
    [input.workspaceId, "workspace id"]
  ] as const) {
    if (value !== undefined) {
      validateId(value, label);
    }
  }
  if (typeof input.text !== "string") {
    throw new ConversationStoreError("validation_error", "Normalized event text must be a string.");
  }
}

function validateCreateBranchInput(input: CreateBranchInput): void {
  for (const [value, label] of [
    [input.sessionId, "session id"],
    [input.sourceEventId, "source event id"],
    [input.title, "branch title"],
    [input.goal, "branch goal"],
    [input.reason, "branch reason"],
    [input.createdBy, "branch creator"],
    [input.idempotencyKey, "idempotency key"]
  ] as const) {
    validateId(value, label);
  }
  if (input.id !== undefined) {
    validateId(input.id, "branch id");
  }
  if (input.parentMainlineId !== undefined) {
    validateId(input.parentMainlineId, "parent mainline id");
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateTransitionBranchInput(input: TransitionBranchInput): void {
  validateId(input.idempotencyKey, "idempotency key");
  validateTimestamp(input.createdAt, "createdAt");
}

function validateAppendLineEventInput(input: AppendLineEventInput): void {
  validateId(input.type, "event type");
  validateId(input.idempotencyKey, "idempotency key");
  for (const [value, label] of [
    [input.id, "line event id"],
    [input.sessionId, "session id"],
    [input.sourceNormalizedEventId, "normalized event id"],
    [input.sourceEventId, "source event id"],
    [input.causationEventId, "causation event id"],
    [input.correlationId, "correlation id"],
    [input.taskId, "task id"],
    [input.actorId, "actor id"]
  ] as const) {
    if (value !== undefined) {
      validateId(value, label);
    }
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateListLineEventsOptions(options: ListLineEventsOptions): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new ConversationStoreError("validation_error", "Event list limit must be a positive safe integer.");
  }
  for (const [value, label] of [
    [options.afterSequence, "afterSequence"],
    [options.beforeSequence, "beforeSequence"]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ConversationStoreError("validation_error", `${label} must be a non-negative safe integer.`);
    }
  }
}

function validateCreateTaskInput(input: CreateTaskInput): void {
  validateId(input.executor, "task executor");
  validateId(input.idempotencyKey, "idempotency key");
  if (input.id !== undefined) {
    validateId(input.id, "task id");
  }
  if (input.workspaceId !== undefined) {
    validateId(input.workspaceId, "workspace id");
  }
  if (input.sourceEventId !== undefined) {
    validateId(input.sourceEventId, "source event id");
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateTransitionTaskInput(input: TransitionTaskInput): void {
  validateId(input.idempotencyKey, "idempotency key");
  validateTimestamp(input.createdAt, "createdAt");
}

function validateCreateBranchResultInput(input: CreateBranchResultInput): void {
  validateId(input.summary, "branch result summary");
  validateId(input.idempotencyKey, "idempotency key");
  if (input.id !== undefined) {
    validateId(input.id, "branch result id");
  }
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version <= 0)) {
    throw new ConversationStoreError("validation_error", "Branch result version must be a positive safe integer.");
  }
  if (input.sourceEventId !== undefined) {
    validateId(input.sourceEventId, "source event id");
  }
  for (const taskId of input.sourceTaskIds ?? []) {
    validateId(taskId, "source task id");
  }
  if ((input.nextActions ?? []).some((action) => typeof action !== "string")) {
    throw new ConversationStoreError("validation_error", "Branch result next actions must be strings.");
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateMergeInput(input: MergeBranchResultInput): void {
  for (const [value, label] of [
    [input.resultId, "branch result id"],
    [input.id, "branch merge id"],
    [input.eventId, "mainline event id"],
    [input.branchEventId, "branch event id"],
    [input.idempotencyKey, "idempotency key"]
  ] as const) {
    if (value !== undefined) {
      validateId(value, label);
    }
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateCreateConversationNodeInput(input: CreateConversationNodeInput): void {
  validateId(input.kind, "conversation node kind");
  validateId(input.title, "conversation node title");
  validateId(input.createdBy, "conversation node creator");
  validateIdempotencyKey(input.idempotencyKey);
  if (input.id !== undefined) {
    validateId(input.id, "conversation node id");
  }
  if (input.statePatch === null || typeof input.statePatch !== "object" || Array.isArray(input.statePatch)) {
    throw new ConversationStoreError("validation_error", "Conversation node statePatch must be an object.");
  }
  for (const [values, label] of [
    [input.parentIds, "conversation node parent id"],
    [input.sourceEventIds, "conversation node source event id"],
    [input.sourceTaskIds, "conversation node source task id"],
    [input.sourceResultIds, "conversation node source result id"]
  ] as const) {
    for (const value of values ?? []) {
      validateId(value, label);
    }
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateListConversationNodesOptions(options: ListConversationNodesOptions): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new ConversationStoreError("validation_error", "Node list limit must be a positive safe integer.");
  }
  for (const [value, label] of [
    [options.afterOrdinal, "afterOrdinal"],
    [options.beforeOrdinal, "beforeOrdinal"]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ConversationStoreError("validation_error", `${label} must be a non-negative safe integer.`);
    }
  }
}

function validateLocator(locator: ConversationSessionLocator): void {
  validateId(locator.platform, "platform");
  validateId(locator.provider, "provider");
  validateId(locator.channelId, "channel id");
  validateId(locator.conversationId, "conversation id");
  if (!LOCATOR_TYPES.has(locator.conversationType)) {
    throw new ConversationStoreError(
      "validation_error",
      `Unsupported conversation type "${locator.conversationType}".`
    );
  }
}

function resolveSessionId(input: CreateSessionInput): string | undefined {
  return input.id ?? input.sessionId;
}

function locatorsEqual(
  left: ConversationSessionLocator | undefined,
  right: ConversationSessionLocator | undefined
): boolean {
  return (
    left?.platform === right?.platform &&
    left?.provider === right?.provider &&
    left?.channelId === right?.channelId &&
    left?.conversationType === right?.conversationType &&
    left?.conversationId === right?.conversationId
  );
}

function validateId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConversationStoreError("validation_error", `${label} must be a non-empty string.`);
  }
}

function validateIdempotencyKey(value: string): void {
  validateId(value, "idempotency key");
}

function uniqueIds(values: readonly string[], label: string): readonly string[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new ConversationStoreError("validation_error", `${label} must not contain duplicates.`);
  }
  for (const value of unique) {
    validateId(value, label);
  }
  return unique;
}

function validateTimestamp(value: string | undefined, label: string, required = false): void {
  if (value === undefined) {
    if (required) {
      throw new ConversationStoreError("validation_error", `${label} is required.`);
    }
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConversationStoreError("validation_error", `${label} must be a non-empty string.`);
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isSqliteConstraintError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

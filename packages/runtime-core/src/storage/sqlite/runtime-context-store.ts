import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ConversationType, WorkspaceRef } from "../../context/types.js";
import type {
  AcceptNormalizedEventInput,
  AcceptedNormalizedEvent,
  AppendLineEventInput,
  BranchContext,
  BranchMerge,
  BranchResult,
  BranchResultTrace,
  ConversationBranch,
  ConversationContextSnapshot,
  ConversationLine,
  ConversationLineHead,
  ConversationMainline,
  ConversationNode,
  ConversationRecoveryState,
  ConversationSession,
  ConversationStore,
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
  ReconstructedConversationState,
  TaskTrace,
  TransitionBranchInput,
  TransitionSessionInput,
  TransitionTaskInput
} from "../../conversation/types.js";
import { eventProcessKey, normalizeMessageId } from "../../context/session.js";
import type { WorkspaceResolveInput, WorkspaceStore } from "../../context/workspace.js";
import type {
  EventProcessBeginInput,
  EventProcessClaim,
  EventProcessClaimInput,
  EventProcessState,
  EventProcessStatus,
  EventProcessStore
} from "../../event-process/types.js";
import type {
  TranscriptAppendInput,
  TranscriptExternalMessageLookup,
  TranscriptListRecentOptions,
  TranscriptMessage,
  TranscriptStore
} from "../../transcript/types.js";
import { SqliteConversationRepository } from "./conversation-store.js";
import { migrateSqliteRuntimeContextStore } from "./migrations.js";

export interface SqliteRuntimeContextStoreOptions {
  readonly databasePath: string;
}

interface ConversationMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly line_id: string | null;
  readonly normalized_event_id: string | null;
  readonly line_event_id: string | null;
  readonly platform: string;
  readonly provider: string;
  readonly channel_id: string;
  readonly conversation_type: ConversationType;
  readonly conversation_id: string;
  readonly source_event_id: string | null;
  readonly role: TranscriptMessage["role"];
  readonly actor_id: string | null;
  readonly text: string;
  readonly message_json: string | null;
  readonly raw_payload_json: string | null;
  readonly event_type: string | null;
  readonly idempotency_key: string | null;
  readonly created_at: string;
  readonly deleted_at: string | null;
  readonly external_message_id: string | null;
}

interface EventProcessStateRow {
  readonly id: string;
  readonly status: EventProcessStatus;
  readonly updated_at: string;
  readonly incoming_message_id: string | null;
  readonly assistant_message_id: string | null;
  readonly agent_output_text: string | null;
  readonly agent_output_json: string | null;
  readonly send_result_json: string | null;
  readonly error_json: string | null;
}

export class SqliteRuntimeContextStore
  implements TranscriptStore, EventProcessStore, WorkspaceStore, ConversationStore
{
  readonly #db: Database.Database;
  readonly #conversation: SqliteConversationRepository;

  constructor(options: SqliteRuntimeContextStoreOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.#db = new Database(options.databasePath);
    try {
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("foreign_keys = ON");
      migrateSqliteRuntimeContextStore(this.#db);
      this.#conversation = new SqliteConversationRepository(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  acceptNormalizedEvent(input: AcceptNormalizedEventInput): Promise<AcceptedNormalizedEvent> {
    return this.#conversation.acceptNormalizedEvent(input);
  }

  getNormalizedEvent(eventId: string): Promise<NormalizedEvent | undefined> {
    return this.#conversation.getNormalizedEvent(eventId);
  }

  listNormalizedEvents(sessionId: string): Promise<readonly NormalizedEvent[]> {
    return this.#conversation.listNormalizedEvents(sessionId);
  }

  createSession(input: CreateSessionInput): Promise<ConversationSession> {
    return this.#conversation.createSession(input);
  }

  ensureSession(input: CreateSessionInput): Promise<ConversationSession> {
    return this.#conversation.ensureSession(input);
  }

  getSession(sessionId: string): Promise<ConversationSession | undefined> {
    return this.#conversation.getSession(sessionId);
  }

  transitionSession(sessionId: string, input: TransitionSessionInput): Promise<ConversationSession> {
    return this.#conversation.transitionSession(sessionId, input);
  }

  getLine(lineId: string): Promise<ConversationLine | undefined> {
    return this.#conversation.getLine(lineId);
  }

  getMainline(sessionId: string): Promise<ConversationMainline> {
    return this.#conversation.getMainline(sessionId);
  }

  listLines(sessionId: string, options?: ListLinesOptions): Promise<readonly ConversationLine[]> {
    return this.#conversation.listLines(sessionId, options);
  }

  createBranch(input: CreateBranchInput): Promise<ConversationBranch> {
    return this.#conversation.createBranch(input);
  }

  getBranch(branchId: string): Promise<ConversationBranch | undefined> {
    return this.#conversation.getBranch(branchId);
  }

  listBranches(sessionId: string, options?: ListBranchesOptions): Promise<readonly ConversationBranch[]> {
    return this.#conversation.listBranches(sessionId, options);
  }

  transitionBranch(branchId: string, input: TransitionBranchInput): Promise<ConversationBranch> {
    return this.#conversation.transitionBranch(branchId, input);
  }

  appendEvent(lineId: string, input: AppendLineEventInput): Promise<LineEvent> {
    return this.#conversation.appendEvent(lineId, input);
  }

  getEvent(eventId: string): Promise<LineEvent | undefined> {
    return this.#conversation.getEvent(eventId);
  }

  listEvents(lineId: string, options?: ListLineEventsOptions): Promise<readonly LineEvent[]> {
    return this.#conversation.listEvents(lineId, options);
  }

  createTask(branchId: string, input: CreateTaskInput): Promise<ConversationTask> {
    return this.#conversation.createTask(branchId, input);
  }

  getTask(taskId: string): Promise<ConversationTask | undefined> {
    return this.#conversation.getTask(taskId);
  }

  listTasks(branchId: string, options?: ListTasksOptions): Promise<readonly ConversationTask[]> {
    return this.#conversation.listTasks(branchId, options);
  }

  transitionTask(taskId: string, input: TransitionTaskInput): Promise<ConversationTask> {
    return this.#conversation.transitionTask(taskId, input);
  }

  createBranchResult(branchId: string, input: CreateBranchResultInput): Promise<BranchResult> {
    return this.#conversation.createBranchResult(branchId, input);
  }

  getBranchResult(resultId: string): Promise<BranchResult | undefined> {
    return this.#conversation.getBranchResult(resultId);
  }

  listBranchResults(branchId: string): Promise<readonly BranchResult[]> {
    return this.#conversation.listBranchResults(branchId);
  }

  mergeBranchResult(branchId: string, mainlineId: string, input?: MergeBranchResultInput): Promise<BranchMerge> {
    return this.#conversation.mergeBranchResult(branchId, mainlineId, input);
  }

  createNode(lineId: string, input: CreateConversationNodeInput): Promise<ConversationNode> {
    return this.#conversation.createNode(lineId, input);
  }

  getNode(nodeId: string): Promise<ConversationNode | undefined> {
    return this.#conversation.getNode(nodeId);
  }

  listNodes(lineId: string, options?: ListConversationNodesOptions): Promise<readonly ConversationNode[]> {
    return this.#conversation.listNodes(lineId, options);
  }

  getLineHead(lineId: string): Promise<ConversationLineHead | undefined> {
    return this.#conversation.getLineHead(lineId);
  }

  createContextSnapshot(
    lineId: string,
    input: CreateConversationContextSnapshotInput
  ): Promise<ConversationContextSnapshot> {
    return this.#conversation.createContextSnapshot(lineId, input);
  }

  getLatestContextSnapshot(lineId: string): Promise<ConversationContextSnapshot | undefined> {
    return this.#conversation.getLatestContextSnapshot(lineId);
  }

  reconstructLineState(lineId: string, headNodeId?: string): Promise<ReconstructedConversationState> {
    return this.#conversation.reconstructLineState(lineId, headNodeId);
  }

  getBranchContext(branchId: string): Promise<BranchContext> {
    return this.#conversation.getBranchContext(branchId);
  }

  getRecoveryState(sessionId?: string): Promise<ConversationRecoveryState> {
    return this.#conversation.getRecoveryState(sessionId);
  }

  getTaskTrace(taskId: string): Promise<TaskTrace> {
    return this.#conversation.getTaskTrace(taskId);
  }

  getEventTrace(eventId: string): Promise<EventTrace> {
    return this.#conversation.getEventTrace(eventId);
  }

  getBranchResultTrace(resultId: string): Promise<BranchResultTrace> {
    return this.#conversation.getBranchResultTrace(resultId);
  }

  async append(input: TranscriptAppendInput): Promise<TranscriptMessage> {
    const transaction = this.#db.transaction(() => {
      if (input.idempotencyKey !== undefined) {
        const idempotent = this.#db
          .prepare(`
          SELECT *
          FROM conversation_messages
          WHERE session_id = ?
            AND COALESCE(line_id, '') = ?
            AND idempotency_key = ?
          LIMIT 1
        `)
          .get(input.sessionId, input.lineId ?? "", input.idempotencyKey) as ConversationMessageRow | undefined;

        if (idempotent !== undefined) {
          return transcriptMessageFromRow(idempotent);
        }
      }

      if (input.sourceEventId !== undefined) {
        const existing = this.#db
          .prepare(`
          SELECT *
          FROM conversation_messages
          WHERE platform = ?
            AND provider = ?
            AND channel_id = ?
            AND conversation_type = ?
            AND conversation_id = ?
            AND source_event_id = ?
          LIMIT 1
        `)
          .get(
            input.platform,
            input.provider,
            input.channelId,
            input.conversationType,
            input.conversationId,
            input.sourceEventId
          ) as ConversationMessageRow | undefined;

        if (existing !== undefined) {
          return transcriptMessageFromRow(existing);
        }
      }

      const message: TranscriptMessage = {
        id: `msg-${randomUUID()}`,
        createdAt: input.createdAt ?? new Date().toISOString(),
        ...input
      };
      this.#db
        .prepare(`
        INSERT INTO conversation_messages (
          id,
          session_id,
          line_id,
          normalized_event_id,
          line_event_id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id,
          role,
          actor_id,
          text,
          message_json,
          raw_payload_json,
          event_type,
          idempotency_key,
          created_at,
          deleted_at,
          external_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `)
        .run(
          message.id,
          message.sessionId,
          message.lineId ?? null,
          message.normalizedEventId ?? null,
          message.lineEventId ?? null,
          message.platform,
          message.provider,
          message.channelId,
          message.conversationType,
          message.conversationId,
          message.sourceEventId ?? null,
          message.role,
          message.actorId ?? null,
          message.text,
          serializeOptionalJson(message.message),
          serializeOptionalJson(message.rawPayload),
          message.eventType ?? null,
          message.idempotencyKey ?? null,
          message.createdAt,
          message.externalMessageId ?? null
        );
      return message;
    });

    return transaction();
  }

  async listRecent(
    sessionId: string,
    options: TranscriptListRecentOptions = {}
  ): Promise<readonly TranscriptMessage[]> {
    const limit = options.limit ?? 20;
    const rows =
      options.lineId === undefined
        ? (this.#db
            .prepare(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
            .all(sessionId, limit) as ConversationMessageRow[])
        : (this.#db
            .prepare(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ?
        AND line_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
            .all(sessionId, options.lineId, limit) as ConversationMessageRow[]);

    return rows.toReversed().map(transcriptMessageFromRow);
  }

  async findByExternalMessageId(input: TranscriptExternalMessageLookup): Promise<TranscriptMessage | undefined> {
    const externalMessageId = normalizeMessageId(input.externalMessageId);
    if (externalMessageId === undefined) {
      return undefined;
    }

    const row = this.#db
      .prepare(`
      SELECT *
      FROM conversation_messages
      WHERE platform = ?
        AND provider = ?
        AND channel_id = ?
        AND conversation_type = ?
        AND conversation_id = ?
        AND role = 'assistant'
        AND external_message_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
      .get(
        input.platform,
        input.provider,
        input.channelId,
        input.conversationType,
        input.conversationId,
        externalMessageId
      ) as ConversationMessageRow | undefined;

    return row === undefined ? undefined : transcriptMessageFromRow(row);
  }

  async begin(input: EventProcessBeginInput): Promise<EventProcessState> {
    const transaction = this.#db.transaction(() => {
      const id = eventProcessKey(input);
      const now = new Date().toISOString();
      this.#db
        .prepare(`
        INSERT OR IGNORE INTO event_process_state (
          id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id,
          source_event_type,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
      `)
        .run(
          id,
          input.platform,
          input.provider,
          input.channelId,
          input.conversationType,
          input.conversationId,
          input.sourceEventId,
          input.sourceEventType,
          now,
          now
        );

      return this.#findEventProcessState(input);
    });

    return transaction();
  }

  async claim(id: string, input: EventProcessClaimInput): Promise<EventProcessClaim> {
    const transaction = this.#db.transaction(() => {
      const updatedAt = new Date().toISOString();
      const result = this.#db
        .prepare(`
          UPDATE event_process_state
          SET status = 'processing',
              updated_at = ?
          WHERE id = ?
            AND status = ?
            AND updated_at = ?
        `)
        .run(updatedAt, id, input.expectedStatus, input.expectedUpdatedAt);

      return {
        claimed: result.changes === 1,
        state: this.#getEventProcessState(id)
      };
    });

    return transaction.immediate();
  }

  async update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): Promise<EventProcessState> {
    const transaction = this.#db.transaction(() => {
      const existing = this.#getEventProcessState(id);
      const next: EventProcessState = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString()
      };
      this.#db
        .prepare(`
        UPDATE event_process_state
        SET status = ?,
            incoming_message_id = ?,
            assistant_message_id = ?,
            agent_output_text = ?,
            agent_output_json = ?,
            send_result_json = ?,
            error_json = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .run(
          next.status,
          next.incomingMessageId ?? null,
          next.assistantMessageId ?? null,
          next.agentOutputText ?? null,
          next.agentOutputJson ?? null,
          next.sendResultJson ?? null,
          next.errorJson ?? null,
          next.updatedAt,
          id
        );

      return next;
    });

    return transaction();
  }

  async resolveWorkspace(input: WorkspaceResolveInput): Promise<WorkspaceRef> {
    const transaction = this.#db.transaction(() => {
      const existing = this.#findBoundWorkspace(input);

      if (existing !== undefined) {
        return existing;
      }

      const now = new Date().toISOString();
      this.#db
        .prepare(`
        INSERT OR IGNORE INTO workspaces (id, type, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
        .run(input.defaultWorkspace.id, input.defaultWorkspace.type, input.defaultWorkspace.name, now, now);

      if (input.defaultWorkspace.type === "personal") {
        this.#db
          .prepare(`
          INSERT OR IGNORE INTO workspace_bindings (
            id,
            workspace_id,
            binding_type,
            identity_id,
            created_at
          ) VALUES (?, ?, 'identity', ?, ?)
        `)
          .run(`wbind-${randomUUID()}`, input.defaultWorkspace.id, input.identityId, now);
      } else {
        this.#db
          .prepare(`
          INSERT OR IGNORE INTO workspace_bindings (
            id,
            workspace_id,
            binding_type,
            platform,
            provider,
            channel_id,
            conversation_type,
            conversation_id,
            created_at
          ) VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?)
        `)
          .run(
            `wbind-${randomUUID()}`,
            input.defaultWorkspace.id,
            input.platform,
            input.provider,
            input.channelId,
            input.conversationType,
            input.conversationId,
            now
          );
      }

      return input.defaultWorkspace;
    });

    return transaction();
  }

  close(): void {
    this.#db.close();
  }

  #findBoundWorkspace(input: WorkspaceResolveInput): WorkspaceRef | undefined {
    if (input.defaultWorkspace.type === "personal") {
      return this.#db
        .prepare(`
        SELECT workspaces.id, workspaces.type, workspaces.name
        FROM workspace_bindings
        JOIN workspaces ON workspaces.id = workspace_bindings.workspace_id
        WHERE workspace_bindings.binding_type = 'identity'
          AND workspace_bindings.identity_id = ?
          AND workspace_bindings.deleted_at IS NULL
          AND workspaces.deleted_at IS NULL
        ORDER BY workspace_bindings.created_at DESC
        LIMIT 1
      `)
        .get(input.identityId) as WorkspaceRef | undefined;
    }

    return this.#db
      .prepare(`
      SELECT workspaces.id, workspaces.type, workspaces.name
      FROM workspace_bindings
      JOIN workspaces ON workspaces.id = workspace_bindings.workspace_id
      WHERE workspace_bindings.binding_type = 'conversation'
        AND workspace_bindings.platform = ?
        AND workspace_bindings.provider = ?
        AND workspace_bindings.channel_id = ?
        AND workspace_bindings.conversation_type = ?
        AND workspace_bindings.conversation_id = ?
        AND workspace_bindings.deleted_at IS NULL
        AND workspaces.deleted_at IS NULL
      ORDER BY workspace_bindings.created_at DESC
      LIMIT 1
    `)
      .get(input.platform, input.provider, input.channelId, input.conversationType, input.conversationId) as
      | WorkspaceRef
      | undefined;
  }

  #getEventProcessState(id: string): EventProcessState {
    const row = this.#db
      .prepare(`
      SELECT
        id,
        status,
        updated_at,
        incoming_message_id,
        assistant_message_id,
        agent_output_text,
        agent_output_json,
        send_result_json,
        error_json
      FROM event_process_state
      WHERE id = ?
      LIMIT 1
    `)
      .get(id) as EventProcessStateRow | undefined;

    if (row === undefined) {
      throw new Error(`Event process state "${id}" does not exist.`);
    }

    return eventProcessStateFromRow(row);
  }

  #findEventProcessState(input: EventProcessBeginInput): EventProcessState {
    const row = this.#db
      .prepare(`
        SELECT
          id,
          status,
          updated_at,
          incoming_message_id,
          assistant_message_id,
          agent_output_text,
          agent_output_json,
          send_result_json,
          error_json
        FROM event_process_state
        WHERE platform = ?
          AND provider = ?
          AND channel_id = ?
          AND source_event_id = ?
          AND source_event_type = ?
        LIMIT 1
      `)
      .get(input.platform, input.provider, input.channelId, input.sourceEventId, input.sourceEventType) as
      | EventProcessStateRow
      | undefined;

    if (row === undefined) {
      throw new Error(
        `Event process state for "${input.platform}/${input.provider}/${input.channelId}/${input.sourceEventId}/${input.sourceEventType}" does not exist.`
      );
    }

    return eventProcessStateFromRow(row);
  }
}

function transcriptMessageFromRow(row: ConversationMessageRow): TranscriptMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.line_id === null ? {} : { lineId: row.line_id }),
    ...(row.normalized_event_id === null ? {} : { normalizedEventId: row.normalized_event_id }),
    ...(row.line_event_id === null ? {} : { lineEventId: row.line_event_id }),
    platform: row.platform,
    provider: row.provider,
    channelId: row.channel_id,
    conversationType: row.conversation_type,
    conversationId: row.conversation_id,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    role: row.role,
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    text: row.text,
    ...(row.message_json === null
      ? {}
      : { message: parseJson<NonNullable<TranscriptMessage["message"]>>(row.message_json) }),
    ...(row.raw_payload_json === null ? {} : { rawPayload: parseJson(row.raw_payload_json) }),
    ...(row.event_type === null ? {} : { eventType: row.event_type }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    createdAt: row.created_at,
    ...(row.external_message_id === null ? {} : { externalMessageId: row.external_message_id }),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at })
  };
}

function serializeOptionalJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  const serialized = JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate
  );
  if (serialized === undefined) {
    throw new Error("Transcript payload is not JSON serializable.");
  }
  return serialized;
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}

function eventProcessStateFromRow(row: EventProcessStateRow): EventProcessState {
  return {
    id: row.id,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.incoming_message_id === null ? {} : { incomingMessageId: row.incoming_message_id }),
    ...(row.assistant_message_id === null ? {} : { assistantMessageId: row.assistant_message_id }),
    ...(row.agent_output_text === null ? {} : { agentOutputText: row.agent_output_text }),
    ...(row.agent_output_json === null ? {} : { agentOutputJson: row.agent_output_json }),
    ...(row.send_result_json === null ? {} : { sendResultJson: row.send_result_json }),
    ...(row.error_json === null ? {} : { errorJson: row.error_json })
  };
}

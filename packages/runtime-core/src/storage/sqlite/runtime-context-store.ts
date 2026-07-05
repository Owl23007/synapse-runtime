import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ConversationType, WorkspaceRef } from "../../context/types.js";
import { eventProcessKey, normalizeMessageId } from "../../context/session.js";
import type { WorkspaceResolveInput, WorkspaceStore } from "../../context/workspace.js";
import type {
  EventProcessBeginInput,
  EventProcessState,
  EventProcessStatus,
  EventProcessStore
} from "../../event-process/types.js";
import type {
  TranscriptAppendInput,
  TranscriptExternalMessageLookup,
  TranscriptMessage,
  TranscriptStore
} from "../../transcript/types.js";
import { migrateSqliteRuntimeContextStore } from "./migrations.js";

export interface SqliteRuntimeContextStoreOptions {
  readonly databasePath: string;
}

interface ConversationMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly platform: string;
  readonly provider: string;
  readonly channel_id: string;
  readonly conversation_type: ConversationType;
  readonly conversation_id: string;
  readonly source_event_id: string | null;
  readonly role: TranscriptMessage["role"];
  readonly actor_id: string | null;
  readonly text: string;
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
  readonly send_result_json: string | null;
  readonly error_json: string | null;
}

export class SqliteRuntimeContextStore implements TranscriptStore, EventProcessStore, WorkspaceStore {
  readonly #db: Database.Database;

  constructor(options: SqliteRuntimeContextStoreOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.#db = new Database(options.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    migrateSqliteRuntimeContextStore(this.#db);
  }

  async append(input: TranscriptAppendInput): Promise<TranscriptMessage> {
    const transaction = this.#db.transaction(() => {
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
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id,
          role,
          actor_id,
          text,
          created_at,
          deleted_at,
          external_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `)
        .run(
          message.id,
          message.sessionId,
          message.platform,
          message.provider,
          message.channelId,
          message.conversationType,
          message.conversationId,
          message.sourceEventId ?? null,
          message.role,
          message.actorId ?? null,
          message.text,
          message.createdAt,
          message.externalMessageId ?? null
        );
      return message;
    });

    return transaction();
  }

  async listRecent(
    sessionId: string,
    options: { readonly limit?: number } = {}
  ): Promise<readonly TranscriptMessage[]> {
    const limit = options.limit ?? 20;
    const rows = this.#db
      .prepare(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
      .all(sessionId, limit) as ConversationMessageRow[];

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
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
      `)
        .run(
          id,
          input.platform,
          input.provider,
          input.channelId,
          input.conversationType,
          input.conversationId,
          input.sourceEventId,
          now,
          now
        );

      return this.#getEventProcessState(id);
    });

    return transaction();
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
}

function transcriptMessageFromRow(row: ConversationMessageRow): TranscriptMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    provider: row.provider,
    channelId: row.channel_id,
    conversationType: row.conversation_type,
    conversationId: row.conversation_id,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    role: row.role,
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    text: row.text,
    createdAt: row.created_at,
    ...(row.external_message_id === null ? {} : { externalMessageId: row.external_message_id }),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at })
  };
}

function eventProcessStateFromRow(row: EventProcessStateRow): EventProcessState {
  return {
    id: row.id,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.incoming_message_id === null ? {} : { incomingMessageId: row.incoming_message_id }),
    ...(row.assistant_message_id === null ? {} : { assistantMessageId: row.assistant_message_id }),
    ...(row.agent_output_text === null ? {} : { agentOutputText: row.agent_output_text }),
    ...(row.send_result_json === null ? {} : { sendResultJson: row.send_result_json }),
    ...(row.error_json === null ? {} : { errorJson: row.error_json })
  };
}

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { PromptContext, PromptContextMessage } from "@synapse/runtime-conversation";
import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";

export type ConversationType = "private" | "group" | "cli" | "system";
export type WorkspaceType = "personal" | "group" | "system";

export interface PlatformIdentity {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly platformUserId: string;
  readonly displayName?: string;
}

export interface SynapseIdentity {
  readonly id: string;
  readonly type: "guest" | "owner" | "system";
  readonly trustLevel: "guest" | "owner" | "system";
  readonly displayName?: string;
  readonly roles: readonly string[];
}

export interface RuntimeActor {
  readonly identity: SynapseIdentity;
  readonly platformIdentity: PlatformIdentity;
  readonly isBound: boolean;
}

export interface WorkspaceRef {
  readonly id: string;
  readonly type: WorkspaceType;
  readonly name: string;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly actorId?: string;
  readonly text: string;
  readonly createdAt: string;
  readonly deletedAt?: string;
}

export interface TranscriptAppendInput {
  readonly sessionId: string;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly actorId?: string;
  readonly text: string;
  readonly createdAt?: string;
}

export interface TranscriptStore {
  append(input: TranscriptAppendInput): Promise<TranscriptMessage>;
  listRecent(sessionId: string, options?: { readonly limit?: number }): Promise<readonly TranscriptMessage[]>;
}

export class InMemoryTranscriptStore implements TranscriptStore {
  readonly #messages: TranscriptMessage[] = [];
  readonly #sourceIndex = new Map<string, TranscriptMessage>();

  async append(input: TranscriptAppendInput): Promise<TranscriptMessage> {
    const sourceKey = input.sourceEventId === undefined ? undefined : transcriptSourceKey(input);
    const existing = sourceKey === undefined ? undefined : this.#sourceIndex.get(sourceKey);

    if (existing !== undefined) {
      return existing;
    }

    const message: TranscriptMessage = {
      id: `msg-${this.#messages.length + 1}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...input
    };
    this.#messages.push(message);

    if (sourceKey !== undefined) {
      this.#sourceIndex.set(sourceKey, message);
    }

    return message;
  }

  async listRecent(sessionId: string, options: { readonly limit?: number } = {}): Promise<readonly TranscriptMessage[]> {
    const limit = options.limit ?? 20;

    return this.#messages
      .filter((message) => message.sessionId === sessionId && message.deletedAt === undefined)
      .slice(-limit);
  }
}

export interface IdentityResolver {
  resolve(event: SynapseChannelEvent, provider: string): Promise<RuntimeActor>;
}

export class IdentityResolverLite implements IdentityResolver {
  readonly #owners: ReadonlySet<string>;

  constructor(options: { readonly ownerPlatformUserIds?: readonly string[] } = {}) {
    this.#owners = new Set(options.ownerPlatformUserIds ?? []);
  }

  async resolve(event: SynapseChannelEvent, provider: string): Promise<RuntimeActor> {
    const platformIdentity: PlatformIdentity = {
      platform: event.platform,
      provider,
      channelId: event.channelId,
      platformUserId: event.sender.id,
      ...(event.sender.displayName === undefined ? {} : { displayName: event.sender.displayName })
    };
    const isOwner = this.#owners.has(event.sender.id) || event.sender.roles?.includes("owner") === true;
    const type = isOwner ? "owner" : event.conversation.kind === "system" ? "system" : "guest";
    const id =
      type === "system"
        ? "system:runtime"
        : `${type}:${event.platform}:${provider}:${event.channelId}:${event.sender.id}`;

    return {
      identity: {
        id,
        type,
        trustLevel: type,
        ...(event.sender.displayName === undefined ? {} : { displayName: event.sender.displayName }),
        roles: event.sender.roles ?? []
      },
      platformIdentity,
      isBound: isOwner
    };
  }
}

export interface WorkspaceResolver {
  resolve(event: SynapseChannelEvent, actor: RuntimeActor): Promise<WorkspaceRef>;
}

export interface WorkspaceResolveInput {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly identityId: string;
  readonly defaultWorkspace: WorkspaceRef;
}

export interface WorkspaceStore {
  resolveWorkspace(input: WorkspaceResolveInput): Promise<WorkspaceRef>;
}

export class WorkspaceResolverLite implements WorkspaceResolver {
  readonly #workspaceStore: WorkspaceStore | undefined;

  constructor(options: { readonly workspaceStore?: WorkspaceStore } = {}) {
    this.#workspaceStore = options.workspaceStore;
  }

  async resolve(event: SynapseChannelEvent, actor: RuntimeActor): Promise<WorkspaceRef> {
    const conversationType = conversationTypeFromEvent(event);
    const defaultWorkspace = defaultWorkspaceForEvent(event, actor);

    return this.#workspaceStore?.resolveWorkspace({
      platform: event.platform,
      provider: actor.platformIdentity.provider,
      channelId: event.channelId,
      conversationType,
      conversationId: event.conversation.id,
      identityId: actor.identity.id,
      defaultWorkspace
    }) ?? defaultWorkspace;
  }
}

function defaultWorkspaceForEvent(event: SynapseChannelEvent, actor: RuntimeActor): WorkspaceRef {
    if (event.conversation.kind === "group") {
      return { id: `group:${event.platform}:${event.channelId}:${event.conversation.id}`, type: "group", name: event.conversation.title ?? event.conversation.id };
    }

    if (event.conversation.kind === "system") {
      return { id: "system:runtime-admin", type: "system", name: "runtime-admin" };
    }

    return { id: `personal:${actor.identity.id}`, type: "personal", name: actor.identity.displayName ?? actor.identity.id };
}

export interface OutputPolicy {
  readonly mode: "normal" | "concise" | "system";
  readonly maxChars: number;
  readonly allowMarkdown: boolean;
  readonly allowCodeBlock: boolean;
  readonly appendExpandHint: boolean;
}

export class OutputPolicyResolver {
  resolve(workspace: WorkspaceRef): OutputPolicy {
    if (workspace.type === "group") {
      return { mode: "concise", maxChars: 600, allowMarkdown: false, allowCodeBlock: false, appendExpandHint: true };
    }

    if (workspace.type === "system") {
      return { mode: "system", maxChars: 2000, allowMarkdown: true, allowCodeBlock: true, appendExpandHint: false };
    }

    return { mode: "normal", maxChars: 4000, allowMarkdown: true, allowCodeBlock: true, appendExpandHint: false };
  }
}

export class ResponsePolicy {
  apply(message: SynapseMessage, policy: OutputPolicy): SynapseMessage {
    const text = applyTextPolicy(getTextContent(message), policy);
    return { ...message, segments: [{ type: "text", text }] };
  }
}

export interface ContextComposerOptions {
  readonly transcriptStore: TranscriptStore;
  readonly maxHistoryChars?: number;
}

export class ContextComposer {
  readonly #transcriptStore: TranscriptStore;
  readonly #maxHistoryChars: number;

  constructor(options: ContextComposerOptions) {
    this.#transcriptStore = options.transcriptStore;
    this.#maxHistoryChars = options.maxHistoryChars ?? 6000;
  }

  async compose(input: {
    readonly event: SynapseChannelEvent;
    readonly actor: RuntimeActor;
    readonly workspace: WorkspaceRef;
    readonly outputPolicy: OutputPolicy;
    readonly sessionId: string;
    readonly currentInput: SynapseMessage;
    readonly currentSourceEventId?: string;
    readonly maxMessages: number;
  }): Promise<PromptContext> {
    const recent = await this.#transcriptStore.listRecent(input.sessionId, { limit: input.maxMessages });
    const messages = trimHistory(
      recent
        .filter((message) => message.sourceEventId !== input.currentSourceEventId)
        .map((message): PromptContextMessage => ({
          role: message.role,
          content: message.text,
          messageId: message.id,
          createdAt: message.createdAt
        })),
      this.#maxHistoryChars
    );

    return {
      system: buildContextSystemPrompt(input.workspace, input.outputPolicy),
      messages,
      metadata: {
        actorId: input.actor.identity.id,
        workspaceId: input.workspace.id,
        workspaceType: input.workspace.type,
        sessionId: input.sessionId
      }
    };
  }
}

export type EventProcessStatus =
  | "received"
  | "processing"
  | "agent_completed"
  | "send_succeeded"
  | "send_failed"
  | "completed";

export interface EventProcessState {
  readonly id: string;
  readonly status: EventProcessStatus;
  readonly updatedAt: string;
  readonly incomingMessageId?: string;
  readonly assistantMessageId?: string;
  readonly agentOutputText?: string;
  readonly sendResultJson?: string;
  readonly errorJson?: string;
}

export interface EventProcessBeginInput {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId: string;
}

export interface EventProcessStore {
  begin(input: EventProcessBeginInput): Promise<EventProcessState>;
  update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): Promise<EventProcessState>;
}

export class InMemoryEventProcessStore implements EventProcessStore {
  readonly #states = new Map<string, EventProcessState>();

  async begin(input: EventProcessBeginInput): Promise<EventProcessState> {
    const id = eventProcessKey(input);
    const existing = this.#states.get(id);

    if (existing !== undefined) {
      return existing;
    }

    const state: EventProcessState = { id, status: "received", updatedAt: new Date().toISOString() };
    this.#states.set(id, state);
    return state;
  }

  async update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): Promise<EventProcessState> {
    const existing = this.#states.get(id);
    if (existing === undefined) {
      throw new Error(`Event process state "${id}" does not exist.`);
    }

    const next: EventProcessState = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.#states.set(id, next);
    return next;
  }
}

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
    this.#migrate();
  }

  async append(input: TranscriptAppendInput): Promise<TranscriptMessage> {
    const transaction = this.#db.transaction(() => {
      if (input.sourceEventId !== undefined) {
        const existing = this.#db.prepare(`
          SELECT *
          FROM conversation_messages
          WHERE platform = ?
            AND provider = ?
            AND channel_id = ?
            AND conversation_type = ?
            AND conversation_id = ?
            AND source_event_id = ?
          LIMIT 1
        `).get(
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
      this.#db.prepare(`
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
          deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
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
        message.createdAt
      );
      return message;
    });

    return transaction();
  }

  async listRecent(sessionId: string, options: { readonly limit?: number } = {}): Promise<readonly TranscriptMessage[]> {
    const limit = options.limit ?? 20;
    const rows = this.#db.prepare(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(sessionId, limit) as ConversationMessageRow[];

    return rows.reverse().map(transcriptMessageFromRow);
  }

  async begin(input: EventProcessBeginInput): Promise<EventProcessState> {
    const transaction = this.#db.transaction(() => {
      const id = eventProcessKey(input);
      const now = new Date().toISOString();
      this.#db.prepare(`
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
      `).run(
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
      this.#db.prepare(`
        UPDATE event_process_state
        SET status = ?,
            incoming_message_id = ?,
            assistant_message_id = ?,
            agent_output_text = ?,
            send_result_json = ?,
            error_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
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
      this.#db.prepare(`
        INSERT OR IGNORE INTO workspaces (id, type, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.defaultWorkspace.id,
        input.defaultWorkspace.type,
        input.defaultWorkspace.name,
        now,
        now
      );

      if (input.defaultWorkspace.type === "personal") {
        this.#db.prepare(`
          INSERT OR IGNORE INTO workspace_bindings (
            id,
            workspace_id,
            binding_type,
            identity_id,
            created_at
          ) VALUES (?, ?, 'identity', ?, ?)
        `).run(
          `wbind-${randomUUID()}`,
          input.defaultWorkspace.id,
          input.identityId,
          now
        );
      } else {
        this.#db.prepare(`
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
        `).run(
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
      return this.#db.prepare(`
        SELECT workspaces.id, workspaces.type, workspaces.name
        FROM workspace_bindings
        JOIN workspaces ON workspaces.id = workspace_bindings.workspace_id
        WHERE workspace_bindings.binding_type = 'identity'
          AND workspace_bindings.identity_id = ?
          AND workspace_bindings.deleted_at IS NULL
          AND workspaces.deleted_at IS NULL
        ORDER BY workspace_bindings.created_at DESC
        LIMIT 1
      `).get(input.identityId) as WorkspaceRef | undefined;
    }

    return this.#db.prepare(`
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
    `).get(
      input.platform,
      input.provider,
      input.channelId,
      input.conversationType,
      input.conversationId
    ) as WorkspaceRef | undefined;
  }

  #getEventProcessState(id: string): EventProcessState {
    const row = this.#db.prepare(`
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
    `).get(id) as EventProcessStateRow | undefined;

    if (row === undefined) {
      throw new Error(`Event process state "${id}" does not exist.`);
    }

    return eventProcessStateFromRow(row);
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        conversation_type TEXT NOT NULL
          CHECK(conversation_type IN ('private', 'group', 'cli', 'system')),
        conversation_id TEXT NOT NULL,
        source_event_id TEXT,
        role TEXT NOT NULL
          CHECK(role IN ('user', 'assistant', 'system')),
        actor_id TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_source_event
      ON conversation_messages(
        platform,
        provider,
        channel_id,
        conversation_type,
        conversation_id,
        source_event_id
      )
      WHERE source_event_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_conv_recent
      ON conversation_messages(session_id, deleted_at, created_at);

      CREATE TABLE IF NOT EXISTS event_process_state (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        conversation_type TEXT NOT NULL
          CHECK(conversation_type IN ('private', 'group', 'cli', 'system')),
        conversation_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN (
            'received',
            'processing',
            'agent_completed',
            'send_succeeded',
            'send_failed',
            'completed'
          )),
        incoming_message_id TEXT,
        assistant_message_id TEXT,
        agent_output_text TEXT,
        agent_output_json TEXT,
        send_result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(incoming_message_id) REFERENCES conversation_messages(id),
        FOREIGN KEY(assistant_message_id) REFERENCES conversation_messages(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_process_unique
      ON event_process_state(
        platform,
        provider,
        channel_id,
        conversation_type,
        conversation_id,
        source_event_id
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL
          CHECK(type IN ('personal', 'group', 'system')),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_bindings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        binding_type TEXT NOT NULL
          CHECK(binding_type IN ('identity', 'conversation')),
        identity_id TEXT,
        platform TEXT,
        provider TEXT,
        channel_id TEXT,
        conversation_type TEXT
          CHECK(conversation_type IS NULL OR conversation_type IN ('private', 'group', 'cli', 'system')),
        conversation_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        CHECK(
          (binding_type = 'identity'
            AND identity_id IS NOT NULL
            AND platform IS NULL
            AND provider IS NULL
            AND channel_id IS NULL
            AND conversation_type IS NULL
            AND conversation_id IS NULL)
          OR
          (binding_type = 'conversation'
            AND identity_id IS NULL
            AND platform IS NOT NULL
            AND provider IS NOT NULL
            AND channel_id IS NOT NULL
            AND conversation_type IS NOT NULL
            AND conversation_id IS NOT NULL)
        ),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_binding_identity
      ON workspace_bindings(workspace_id, identity_id)
      WHERE binding_type = 'identity' AND deleted_at IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_binding_conversation
      ON workspace_bindings(
        workspace_id,
        platform,
        provider,
        channel_id,
        conversation_type,
        conversation_id
      )
      WHERE binding_type = 'conversation' AND deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL
          CHECK(scope_type IN ('identity', 'workspace')),
        scope_id TEXT NOT NULL,
        identity_id TEXT,
        workspace_id TEXT,
        visibility TEXT NOT NULL
          CHECK(visibility IN ('private', 'workspace', 'public', 'secret')),
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        source_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        CHECK(
          (scope_type = 'identity'
            AND identity_id IS NOT NULL
            AND workspace_id IS NULL)
          OR
          (scope_type = 'workspace'
            AND identity_id IS NULL
            AND workspace_id IS NOT NULL)
        ),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_scope_created
      ON memory_records(scope_type, scope_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_visibility
      ON memory_records(visibility, identity_id, workspace_id, deleted_at);
    `);
  }
}

export function conversationTypeFromEvent(event: SynapseChannelEvent): ConversationType {
  if (event.conversation.kind === "channel") {
    return "group";
  }

  return event.conversation.kind;
}

export function buildSessionId(event: SynapseChannelEvent, provider: string): string {
  return `${event.platform}:${provider}:${event.channelId}:${conversationTypeFromEvent(event)}:${event.conversation.id}`;
}

export function buildSourceEventId(event: SynapseChannelEvent, provider: string): string {
  const messageId = normalizeStableId(event.message?.id);
  if (messageId !== undefined) {
    return messageId;
  }

  const eventId = normalizeStableId(event.id);
  if (eventId !== undefined && !looksGeneratedFromWallClock(eventId)) {
    return eventId;
  }

  const roundedReceivedAt = roundedIsoTimestamp(event.receivedAt);
  const text = event.message === undefined ? "" : getTextContent(event.message);
  const digest = createHash("sha256")
    .update([
      event.platform,
      provider,
      event.channelId,
      conversationTypeFromEvent(event),
      event.conversation.id,
      event.sender.id,
      text,
      roundedReceivedAt
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 32);

  return `best-effort:${digest}`;
}

export function anonymousActor(event: SynapseChannelEvent, provider: string): RuntimeActor {
  const platformUserId = event.sender.id.length > 0 ? event.sender.id : "unknown";

  return {
    identity: {
      id: `guest:${event.platform}:${provider}:${event.channelId}:${platformUserId}`,
      type: "guest",
      trustLevel: "guest",
      ...(event.sender.displayName === undefined ? {} : { displayName: event.sender.displayName }),
      roles: []
    },
    platformIdentity: {
      platform: event.platform,
      provider,
      channelId: event.channelId,
      platformUserId,
      ...(event.sender.displayName === undefined ? {} : { displayName: event.sender.displayName })
    },
    isBound: false
  };
}

export function defaultWorkspace(event: SynapseChannelEvent, actor: RuntimeActor): WorkspaceRef {
  return defaultWorkspaceForEvent(event, actor);
}

export function commandResponse(
  event: SynapseChannelEvent,
  actor: RuntimeActor,
  workspace: WorkspaceRef,
  options: { readonly enableDurableMemory?: boolean } = {}
): SynapseMessage | undefined {
  const text = event.message === undefined ? "" : getTextContent(event.message).trim();

  if (text === "/whoami") {
    return {
      type: "text",
      segments: [
        {
          type: "text",
          text: [
            `platform=${actor.platformIdentity.platform}`,
            `provider=${actor.platformIdentity.provider}`,
            `channelId=${actor.platformIdentity.channelId}`,
            `platformUserId=${actor.platformIdentity.platformUserId}`,
            `identityId=${actor.identity.id}`,
            `identityType=${actor.identity.type}`
          ].join("\n")
        }
      ]
    };
  }

  if (text === "/workspace info") {
    return {
      type: "text",
      segments: [{ type: "text", text: `workspaceId=${workspace.id}\nworkspaceType=${workspace.type}\nworkspaceName=${workspace.name}` }]
    };
  }

  if (text.startsWith("/workspace use project:")) {
    return { type: "text", segments: [{ type: "text", text: "Project workspace is not supported in P0." }] };
  }

  if (isMemoryCommand(text) && options.enableDurableMemory !== true) {
    return {
      type: "text",
      segments: [{ type: "text", text: "当前未启用长期记忆。你的消息只会作为当前会话历史使用。" }]
    };
  }

  return undefined;
}

function isMemoryCommand(text: string): boolean {
  return text === "/memory" ||
    text.startsWith("/memory ") ||
    text === "/memory remember" ||
    text.startsWith("/memory remember ") ||
    text === "/memory list" ||
    text.startsWith("/memory list ") ||
    text === "/memory delete" ||
    text.startsWith("/memory delete ");
}

function transcriptSourceKey(input: TranscriptAppendInput): string {
  return [
    input.platform,
    input.provider,
    input.channelId,
    input.conversationType,
    input.conversationId,
    input.sourceEventId
  ].join(":");
}

function eventProcessKey(input: {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId: string;
}): string {
  return [
    input.platform,
    input.provider,
    input.channelId,
    input.conversationType,
    input.conversationId,
    input.sourceEventId
  ].join(":");
}

function normalizeStableId(id: string | undefined): string | undefined {
  const normalized = id?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function looksGeneratedFromWallClock(id: string): boolean {
  return /:\d{13}$/.test(id);
}

function roundedIsoTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  const ms = Number.isNaN(parsed) ? Date.now() : parsed;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function buildContextSystemPrompt(workspace: WorkspaceRef, policy: OutputPolicy): string {
  const constraints =
    workspace.type === "group"
      ? "Group chat: answer briefly, avoid flooding, and ask whether to expand when the answer is long."
      : "Private chat: answer normally and use recent session history when relevant.";

  return `${constraints}\nOutput policy: mode=${policy.mode}, maxChars=${policy.maxChars}, markdown=${policy.allowMarkdown}, codeBlock=${policy.allowCodeBlock}.`;
}

function trimHistory(messages: readonly PromptContextMessage[], maxChars: number): readonly PromptContextMessage[] {
  const result = [...messages];
  let total = result.reduce((sum, message) => sum + message.content.length, 0);

  while (result.length > 0 && total > maxChars) {
    const [removed] = result.splice(0, 1);
    total -= removed?.content.length ?? 0;
  }

  return result;
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

function applyTextPolicy(text: string, policy: OutputPolicy): string {
  let output = text;

  if (!policy.allowCodeBlock) {
    output = output.replace(/```[\s\S]*?```/g, "[Code block omitted. Ask me to expand if needed.]");
  }

  if (!policy.allowMarkdown) {
    output = output
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s*\|.*\|\s*$/gm, "");
  }

  if (output.length <= policy.maxChars) {
    return output;
  }

  const hint = policy.appendExpandHint ? "\n内容较长，需要我展开再说。" : "";
  const room = Math.max(0, policy.maxChars - hint.length);
  return `${output.slice(0, room).trimEnd()}${hint}`.slice(0, policy.maxChars);
}

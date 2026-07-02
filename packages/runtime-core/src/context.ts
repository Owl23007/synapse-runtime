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

export class WorkspaceResolverLite implements WorkspaceResolver {
  async resolve(event: SynapseChannelEvent, actor: RuntimeActor): Promise<WorkspaceRef> {
    if (event.conversation.kind === "group") {
      return { id: `group:${event.platform}:${event.channelId}:${event.conversation.id}`, type: "group", name: event.conversation.title ?? event.conversation.id };
    }

    if (event.conversation.kind === "system") {
      return { id: "system:runtime-admin", type: "system", name: "runtime-admin" };
    }

    return { id: `personal:${actor.identity.id}`, type: "personal", name: actor.identity.displayName ?? actor.identity.id };
  }
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

export class InMemoryEventProcessStore {
  readonly #states = new Map<string, EventProcessState>();

  begin(input: {
    readonly platform: string;
    readonly provider: string;
    readonly channelId: string;
    readonly conversationType: ConversationType;
    readonly conversationId: string;
    readonly sourceEventId: string;
  }): EventProcessState {
    const id = eventProcessKey(input);
    const existing = this.#states.get(id);

    if (existing !== undefined) {
      return existing;
    }

    const state: EventProcessState = { id, status: "received", updatedAt: new Date().toISOString() };
    this.#states.set(id, state);
    return state;
  }

  update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): EventProcessState {
    const existing = this.#states.get(id);
    if (existing === undefined) {
      throw new Error(`Event process state "${id}" does not exist.`);
    }

    const next: EventProcessState = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.#states.set(id, next);
    return next;
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

export function commandResponse(event: SynapseChannelEvent, actor: RuntimeActor, workspace: WorkspaceRef): SynapseMessage | undefined {
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

  return undefined;
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

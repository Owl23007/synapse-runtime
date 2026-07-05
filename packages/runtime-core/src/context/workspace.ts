import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import { conversationTypeFromEvent } from "./session.js";
import type { ConversationType, RuntimeActor, WorkspaceRef } from "./types.js";

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
    const fallbackWorkspace = defaultWorkspaceForEvent(event, actor);

    return (
      this.#workspaceStore?.resolveWorkspace({
        platform: event.platform,
        provider: actor.platformIdentity.provider,
        channelId: event.channelId,
        conversationType,
        conversationId: event.conversation.id,
        identityId: actor.identity.id,
        defaultWorkspace: fallbackWorkspace
      }) ?? fallbackWorkspace
    );
  }
}

export function defaultWorkspace(event: SynapseChannelEvent, actor: RuntimeActor): WorkspaceRef {
  return defaultWorkspaceForEvent(event, actor);
}

function defaultWorkspaceForEvent(event: SynapseChannelEvent, actor: RuntimeActor): WorkspaceRef {
  if (event.conversation.kind === "group") {
    return {
      id: `group:${event.platform}:${event.channelId}:${event.conversation.id}`,
      type: "group",
      name: event.conversation.title ?? event.conversation.id
    };
  }

  if (event.conversation.kind === "system") {
    return { id: "system:runtime-admin", type: "system", name: "runtime-admin" };
  }

  return {
    id: `personal:${actor.identity.id}`,
    type: "personal",
    name: actor.identity.displayName ?? actor.identity.id
  };
}

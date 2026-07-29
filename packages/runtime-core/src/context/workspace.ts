import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import { conversationTypeFromEvent } from "./session.js";
import type { ConversationType, RuntimeActor, WorkspaceRef } from "./types.js";

export interface WorkspaceResolver {
  /** 解析频道事件对应的工作区 */
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
  /** 根据会话与身份绑定解析工作区 */
  resolveWorkspace(input: WorkspaceResolveInput): Promise<WorkspaceRef>;
}

/**
 * 优先读取持久化绑定并回退到默认工作区
 */
export class WorkspaceResolverLite implements WorkspaceResolver {
  readonly #workspaceStore: WorkspaceStore | undefined;

  /**
   * 创建轻量工作区解析器
   */
  constructor(options: { readonly workspaceStore?: WorkspaceStore } = {}) {
    this.#workspaceStore = options.workspaceStore;
  }

  /**
   * 解析事件工作区并在未绑定时返回默认值
   */
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

/**
 * 为未绑定工作区的事件创建默认工作区引用
 */
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

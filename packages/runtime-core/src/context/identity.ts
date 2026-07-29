import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { PlatformIdentity, RuntimeActor } from "./types.js";

export interface IdentityResolver {
  /** 将平台发送者解析为运行时角色 */
  resolve(event: SynapseChannelEvent, provider: string): Promise<RuntimeActor>;
}

/**
 * 基于平台发送者与所有者列表解析运行时角色
 */
export class IdentityResolverLite implements IdentityResolver {
  readonly #owners: ReadonlySet<string>;

  /**
   * 创建轻量身份解析器
   */
  constructor(options: { readonly ownerPlatformUserIds?: readonly string[] } = {}) {
    this.#owners = new Set(options.ownerPlatformUserIds ?? []);
  }

  /**
   * 解析频道事件发送者的运行时身份
   */
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

/**
 * 为无法解析身份的事件创建匿名运行角色
 */
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

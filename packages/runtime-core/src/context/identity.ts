import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { PlatformIdentity, RuntimeActor } from "./types.js";

/** 持久化身份解析的输入 */
export interface IdentityResolveInput {
  readonly identityId: string;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly platformUserId: string;
  readonly type: "guest" | "owner" | "system";
  readonly displayName?: string;
  readonly roles: readonly string[];
  readonly isBound: boolean;
}

/** 身份持久化解析结果 */
export interface PersistedIdentityResolution {
  readonly identity: RuntimeActor["identity"];
  readonly isBound: boolean;
}

/** 身份持久化存储契约 */
export interface IdentityStore {
  /** 创建或读取平台身份到运行时身份的稳定映射 */
  resolveIdentity(input: IdentityResolveInput): Promise<PersistedIdentityResolution>;
}

export interface IdentityResolver {
  /** 将平台发送者解析为运行时角色 */
  resolve(event: SynapseChannelEvent, provider: string): Promise<RuntimeActor>;
}

/**
 * 基于平台发送者与所有者列表解析运行时角色
 */
export class IdentityResolverLite implements IdentityResolver {
  readonly #owners: ReadonlySet<string>;
  readonly #identityStore: IdentityStore | undefined;

  /**
   * 创建轻量身份解析器
   */
  constructor(
    options: { readonly ownerPlatformUserIds?: readonly string[]; readonly identityStore?: IdentityStore } = {}
  ) {
    this.#owners = new Set(options.ownerPlatformUserIds ?? []);
    this.#identityStore = options.identityStore;
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

    const fallbackActor: RuntimeActor = {
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
    if (this.#identityStore === undefined) {
      return fallbackActor;
    }

    const persisted = await this.#identityStore.resolveIdentity({
      identityId: fallbackActor.identity.id,
      platform: event.platform,
      provider,
      channelId: event.channelId,
      platformUserId: event.sender.id,
      type,
      ...(event.sender.displayName === undefined ? {} : { displayName: event.sender.displayName }),
      roles: event.sender.roles ?? [],
      isBound: isOwner
    });
    return {
      identity: persisted.identity,
      platformIdentity,
      isBound: persisted.isBound
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

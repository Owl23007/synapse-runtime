import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { PlatformIdentity, RuntimeActor } from "./types.js";

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

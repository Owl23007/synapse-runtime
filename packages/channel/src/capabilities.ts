import {
  CHANNEL_NATIVE_ACTIONS,
  type ChannelCapability,
  type ChannelCapabilityKey,
  type ChannelCapabilityProfile
} from "@synapse/runtime-protocol";

/** 生成完整的 adapter 能力投影，未映射动作显式不支持，不改变原生能力全集 */
export function createChannelCapabilityProfile(input: {
  readonly channelId: string;
  readonly adapterType: string;
  readonly capabilities: Readonly<Partial<Record<ChannelCapabilityKey, ChannelCapability>>>;
  readonly observedAt?: string;
}): ChannelCapabilityProfile {
  const capabilities: Partial<Record<ChannelCapabilityKey, ChannelCapability>> = {};
  for (const key of [
    ...Object.keys(CHANNEL_NATIVE_ACTIONS),
    "message.receive",
    "message.media"
  ] as ChannelCapabilityKey[]) {
    capabilities[key] = { status: "unsupported", reason: "当前 adapter 尚未实现此原生能力的映射" };
  }
  return {
    schemaVersion: "channel-protocol/v1",
    channelId: input.channelId,
    adapterType: input.adapterType,
    observedAt: input.observedAt ?? new Date().toISOString(),
    capabilities: { ...capabilities, ...input.capabilities }
  };
}

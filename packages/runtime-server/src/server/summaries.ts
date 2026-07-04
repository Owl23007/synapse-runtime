import type { ChannelConfig } from "@synapse/runtime-config";

export function summarizeChannelConfig(channel: ChannelConfig): Readonly<Record<string, unknown>> {
  if (channel.adapter === "qq-official") {
    return {
      adapter: channel.adapter,
      appId: channel.appId,
      appSecret: channel.appSecret,
      mode: channel.mode,
      apiBaseUrl: channel.apiBaseUrl,
      tokenEndpoint: channel.tokenEndpoint,
      webhookPath: channel.webhookPath,
      enabled: channel.enabled,
      riskLevel: channel.riskLevel
    };
  }

  return {
    adapter: channel.adapter,
    provider: channel.provider,
    transport: channel.transport,
    endpoint: channel.endpoint,
    accessToken: channel.accessToken,
    enabled: channel.enabled,
    riskLevel: channel.riskLevel
  };
}

export function summarizeQqOfficialPayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(payload)) {
    return { shape: typeof payload };
  }

  const data = isRecord(payload.d) ? payload.d : undefined;
  return {
    op: payload.op,
    t: payload.t,
    id: payload.id,
    dataKeys: data === undefined ? undefined : Object.keys(data).toSorted(),
    messageId: data?.msg_id ?? data?.id,
    eventId: data?.event_id,
    groupOpenid: data?.group_openid,
    groupId: data?.group_id,
    userOpenid: data?.user_openid ?? (isRecord(data?.author) ? data.author.user_openid : undefined),
    channelId: data?.channel_id,
    guildId: data?.guild_id,
    contentLength: typeof data?.content === "string" ? data.content.length : undefined,
    contentPreview: typeof data?.content === "string" ? previewText(data.content) : undefined
  };
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

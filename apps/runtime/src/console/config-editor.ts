import { readRawConfig, writeRawConfig } from "@synapse/runtime-user-config";
/** 更新用户选择的渠道字段，不写入业务默认值 */
export async function updateChannelConfigFile(
  configPath: string,
  channelId: string,
  patch: Readonly<Record<string, unknown>>
): Promise<void> {
  const raw = await readRawConfig(configPath);
  const root = ensureRecord(raw);
  const channels = ensureRecord(root.channels ?? {});
  const channel = ensureRecord(channels[channelId] ?? {});

  channels[channelId] = { ...channel, ...patch };
  root.channels = channels;

  await writeRawConfig(configPath, root);
}

/** 将新渠道写入用户配置数据 */
export async function addChannelConfigFile(
  configPath: string,
  channelId: string,
  channel: Readonly<Record<string, unknown>>
): Promise<void> {
  const raw = await readRawConfig(configPath);
  const root = ensureRecord(raw);
  const channels = ensureRecord(root.channels ?? {});

  if (channels[channelId] !== undefined) {
    throw new Error(`Channel "${channelId}" already exists.`);
  }

  channels[channelId] = channel;
  root.channels = channels;

  await writeRawConfig(configPath, root);
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

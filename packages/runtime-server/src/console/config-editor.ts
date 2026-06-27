import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

async function readRawConfig(configPath: string): Promise<unknown> {
  const content = await readFile(configPath, "utf8");
  return parseYaml(content);
}

async function writeRawConfig(configPath: string, raw: unknown): Promise<void> {
  await writeFile(configPath, stringifyYaml(raw), "utf8");
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

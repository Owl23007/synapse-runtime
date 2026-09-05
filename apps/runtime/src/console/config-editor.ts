import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
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
  const extension = extname(configPath).toLowerCase();

  if (extension === ".toml" || extension === "") {
    return parseToml(content);
  }

  if (extension === ".json") {
    return JSON.parse(content) as unknown;
  }

  return parseYaml(content);
}

async function writeRawConfig(configPath: string, raw: unknown): Promise<void> {
  const extension = extname(configPath).toLowerCase();

  if (extension === ".toml" || extension === "") {
    await writeFile(configPath, stringifyToml(ensureRecord(raw)), "utf8");
    return;
  }

  if (extension === ".json") {
    await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return;
  }

  await writeFile(configPath, stringifyYaml(raw), "utf8");
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

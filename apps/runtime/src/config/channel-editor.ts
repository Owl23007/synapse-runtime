import { resolve } from "node:path";
import { readRawConfigFile, writeRawConfigFile } from "@synapse/runtime-config/node";
import { parseConfigObject } from "./loader.js";

const writes = new Map<string, Promise<void>>();

/** 可安全返回给管理客户端的配置编辑错误，不包含配置值 */
export class ChannelConfigEditError extends Error {
  constructor(readonly code: "invalid_channel_config" | "channel_not_found" | "channel_already_exists") {
    super(code);
    this.name = "ChannelConfigEditError";
  }
}

/** 更新服务端配置文件中的频道字段，保留环境占位符和用户原始数据 */
export function updateChannelConfigFile(
  configPath: string,
  channelId: string,
  patch: Readonly<Record<string, unknown>>
): Promise<void> {
  return editChannel(configPath, channelId, patch, false);
}

/** 将新频道写入服务端配置文件，不写入展开后的默认值 */
export function addChannelConfigFile(
  configPath: string,
  channelId: string,
  channel: Readonly<Record<string, unknown>>
): Promise<void> {
  return editChannel(configPath, channelId, channel, true);
}

async function editChannel(
  path: string,
  id: string,
  value: Readonly<Record<string, unknown>>,
  add: boolean
): Promise<void> {
  if (!id.trim() || ["__proto__", "constructor", "prototype"].includes(id))
    throw new ChannelConfigEditError("invalid_channel_config");
  const key = resolve(path);
  // 同一文件的读改写排队，避免两个管理请求互相覆盖
  const write = persistChannel(writes.get(key), key, id, value, add);
  writes.set(key, write);
  try {
    await write;
  } finally {
    if (writes.get(key) === write) writes.delete(key);
  }
}

async function persistChannel(
  previous: Promise<void> | undefined,
  key: string,
  id: string,
  value: Readonly<Record<string, unknown>>,
  add: boolean
): Promise<void> {
  try {
    await previous;
  } catch {
    /* 前一次编辑失败不阻塞后续有效写入 */
  }
  const raw = await readRawConfigFile(key);
  if (!isRecord(raw) || (raw.channels !== undefined && !isRecord(raw.channels)))
    throw new ChannelConfigEditError("invalid_channel_config");
  const channels = { ...(raw.channels as Record<string, unknown> | undefined) };
  const exists = Object.hasOwn(channels, id);
  if (add && exists) throw new ChannelConfigEditError("channel_already_exists");
  if (!add && !exists) throw new ChannelConfigEditError("channel_not_found");
  channels[id] = add ? value : { ...(isRecord(channels[id]) ? channels[id] : {}), ...value };
  const next = { ...raw, channels };
  try {
    parseConfigObject(next);
  } catch {
    throw new ChannelConfigEditError("invalid_channel_config");
  }
  await writeRawConfigFile(key, next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

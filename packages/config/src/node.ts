import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ConfigSource } from "./source.js";

/** Node.js 配置文件支持的格式 */
export type ConfigFileFormat = "json" | "toml" | "yaml";

/** 根据配置文件路径解析 TOML、YAML 或 JSON 内容 */
export function parseConfigFileContent(content: string, filePath: string): Record<string, unknown> {
  const format = resolveConfigFileFormat(filePath);
  const value = format === "json" ? JSON.parse(content) : format === "yaml" ? parseYaml(content) : parseToml(content);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config source "${filePath}" must contain an object.`);
  }
  return value as Record<string, unknown>;
}

/** 从 dotenv 文件加载尚未存在的环境变量 */
export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const content = readFileSync(resolve(filePath), "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = stripEnvQuotes(line.slice(separator + 1).trim());
    if (env[key] === undefined) env[key] = value;
  }
}

/** 读取原始配置对象且不附加业务默认值 */
export async function readRawConfigFile(configPath: string): Promise<Record<string, unknown>> {
  return parseConfigFileContent(await readFile(configPath, "utf8"), configPath);
}

/** 原子写入原始配置对象且不持久化解析后的默认值 */
export async function writeRawConfigFile(configPath: string, raw: unknown): Promise<void> {
  const extension = extname(configPath).toLowerCase();
  const record = ensureRecord(raw);
  const content =
    extension === ".json"
      ? `${JSON.stringify(record, null, 2)}\n`
      : extension === ".yaml" || extension === ".yml"
        ? stringifyYaml(record)
        : extension === ".toml" || extension === ""
          ? stringifyToml(record)
          : undefined;
  if (content === undefined) throw new Error(`Unsupported config extension: ${extension}`);
  await atomicWriteFile(configPath, content);
}
/** 从 TOML、YAML 或 JSON 文件读取配置 */
export class FileConfigSource implements ConfigSource {
  constructor(
    readonly id: string,
    readonly priority: number,
    readonly path: string
  ) {}
  async load(): Promise<Record<string, unknown>> {
    const content = await readFile(this.path, "utf8");
    return parseConfigFileContent(content, this.path);
  }
}

function resolveConfigFileFormat(filePath: string): ConfigFileFormat {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  if (extension === ".toml" || extension === "") return "toml";
  throw new Error(`Unsupported config extension: ${extension}`);
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

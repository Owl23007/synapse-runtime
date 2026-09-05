import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteFile } from "./storage.js";
/** 读取用户配置原始数据，不附加业务默认值 */
export async function readRawConfig(configPath: string): Promise<unknown> {
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

/** 写入用户选择的数据，不持久化解析后的默认值 */
export async function writeRawConfig(configPath: string, raw: unknown): Promise<void> {
  const extension = extname(configPath).toLowerCase();

  if (extension === ".toml" || extension === "") {
    await atomicWriteFile(configPath, stringifyToml(ensureRecord(raw)), "utf8");
    return;
  }

  if (extension === ".json") {
    await atomicWriteFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return;
  }

  await atomicWriteFile(configPath, stringifyYaml(raw), "utf8");
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

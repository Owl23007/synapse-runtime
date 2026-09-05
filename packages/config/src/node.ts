import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import type { ConfigSource } from "./source.js";
/** 从 TOML、YAML 或 JSON 文件读取配置 */
export class FileConfigSource implements ConfigSource {
  constructor(
    readonly id: string,
    readonly priority: number,
    readonly path: string
  ) {}
  async load(): Promise<Record<string, unknown>> {
    const content = await readFile(this.path, "utf8");
    const extension = extname(this.path).toLowerCase();
    if (!["", ".json", ".yaml", ".yml", ".toml"].includes(extension))
      throw new Error(`Unsupported config extension: ${extension}`);
    const value =
      extension === ".json"
        ? JSON.parse(content)
        : extension === ".yaml" || extension === ".yml"
          ? parseYaml(content)
          : parseToml(content);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Config source "${this.id}" must contain an object.`);
    return value as Record<string, unknown>;
  }
}

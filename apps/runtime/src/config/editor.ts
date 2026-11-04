import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigResolutionError } from "@synapse/runtime-config";
import { parseConfigFileContent, writeRawConfigFile } from "@synapse/runtime-config/node";
import type {
  ConfigEditorSnapshot,
  ConfigFieldSchema,
  ConfigFileChange,
  ConfigSaveResult
} from "@synapse/runtime-client";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";
import { loadConfigFile, type LoadConfigOptions } from "./loader.js";
import { enqueueConfigFileEdit } from "./file-edits.js";
import { ReloadRequiresRestartError, validateReloadConfig } from "../server/reload-policy.js";

const MASK = "[REDACTED]";
const changeSchema = z
  .object({
    path: z
      .array(
        z
          .string()
          .min(1)
          .refine((key) => !["__proto__", "prototype", "constructor"].includes(key))
      )
      .min(1)
      .max(32),
    value: z.json().optional(),
    remove: z.boolean().optional()
  })
  .strict()
  .refine((change) => (change.remove === true ? !Object.hasOwn(change, "value") : Object.hasOwn(change, "value")));
const requestSchema = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/), changes: z.array(changeSchema).min(1).max(1000) })
  .strict();

/** 配置编辑错误仅暴露字段路径与错误码，避免校验异常泄露密钥值 */
export class ConfigEditError extends Error {
  constructor(
    readonly code: "invalid_config_changes" | "config_conflict" | "invalid_config",
    readonly fields: readonly string[] = []
  ) {
    super(code);
    this.name = "ConfigEditError";
  }
}

/** 返回文件原始值与领域表单规则，避免将环境展开值和默认值误写回文件 */
export async function readConfigEditor(
  path: string,
  current: RuntimeConfig,
  options: LoadConfigOptions = {}
): Promise<ConfigEditorSnapshot> {
  const content = await readFile(path, "utf8");
  const raw = parseConfigFileContent(content, path);
  const secretPaths: string[][] = [];
  const config = maskSecrets(raw, [], secretPaths) as Record<string, unknown>;
  const next = await validateFile(path, raw, options);
  return {
    ok: true,
    revision: revision(content),
    config,
    schema: z.toJSONSchema(RuntimeConfigSchema, {
      io: "input",
      unrepresentable: "any",
      target: "draft-7"
    }) as ConfigFieldSchema,
    secretPaths,
    restartFields: restartFields(current, next)
  };
}

/** 校验完整合并结果后原子写入选中字段，文件版本变化时拒绝覆盖 */
export function saveConfigEditor(
  path: string,
  input: unknown,
  current: RuntimeConfig,
  options: LoadConfigOptions = {}
): Promise<ConfigSaveResult> {
  return enqueueConfigFileEdit(path, async () => {
    const request = requestSchema.safeParse(input);
    if (!request.success) throw new ConfigEditError("invalid_config_changes");
    const content = await readFile(path, "utf8");
    if (request.data.revision !== revision(content)) throw new ConfigEditError("config_conflict");
    const raw = parseConfigFileContent(content, path);
    for (const change of request.data.changes) applyChange(raw, change);
    const next = await validateFile(path, raw, options);
    if (revision(await readFile(path, "utf8")) !== request.data.revision) throw new ConfigEditError("config_conflict");
    await writeRawConfigFile(path, raw);
    return { ok: true, reloadRequired: true, restartFields: restartFields(current, next) };
  });
}

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function validateFile(
  path: string,
  raw: Record<string, unknown>,
  options: LoadConfigOptions
): Promise<RuntimeConfig> {
  try {
    return await loadConfigFile(path, { ...options, deploymentConfig: raw });
  } catch (error) {
    // 不转发 Zod、环境变量和来源异常，其中可能包含用户刚输入的凭据
    const cause = error instanceof Error ? error.cause : undefined;
    const fields =
      cause instanceof z.ZodError
        ? cause.issues.map((issue) =>
            [...(error instanceof ConfigResolutionError ? [error.moduleId] : []), ...issue.path.map(String)].join(".")
          )
        : error instanceof z.ZodError
          ? error.issues.map((issue) => issue.path.map(String).join("."))
          : [];
    throw new ConfigEditError("invalid_config", fields);
  }
}

function restartFields(current: RuntimeConfig, next: RuntimeConfig): readonly string[] {
  try {
    validateReloadConfig(current, next);
    return [];
  } catch (error) {
    if (error instanceof ReloadRequiresRestartError) return error.fields;
    throw error;
  }
}

function maskSecrets(value: unknown, path: string[], secrets: string[][], inherited = false): unknown {
  const key = path.at(-1) ?? "";
  // Token 数量和凭据环境变量名可直接编辑，请求头与环境映射按值隐藏
  const sensitive =
    inherited ||
    /secret|password|credential|privatekey|accesskey|apikey|authorization/i.test(key) ||
    (/token/i.test(key) && !/tokens|tokenenv|tokenendpoint/i.test(key)) ||
    path.some((part) => ["headers", "env", "extraBody"].includes(part));
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value))
      return value.map((item, index) => maskSecrets(item, [...path, String(index)], secrets, sensitive));
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, maskSecrets(item, [...path, name], secrets, sensitive)])
    );
  }
  if (sensitive) {
    secrets.push(path);
    return MASK;
  }
  return value;
}

function applyChange(raw: Record<string, unknown>, change: ConfigFileChange): void {
  if (JSON.stringify(change.value)?.includes(MASK)) throw new ConfigEditError("invalid_config_changes");
  let target: Record<string, unknown> | unknown[] = raw;
  for (const key of change.path.slice(0, -1)) {
    const record = target as Record<string, unknown>;
    if (!Object.hasOwn(target, key)) {
      if (Array.isArray(target) || change.remove) throw new ConfigEditError("invalid_config_changes");
      record[key] = {};
    }
    const child = record[key];
    if (child === null || typeof child !== "object") throw new ConfigEditError("invalid_config_changes");
    target = child as Record<string, unknown>;
  }
  const key = change.path.at(-1)!;
  if (Array.isArray(target)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > target.length || (change.remove && Number(key) === target.length))
      throw new ConfigEditError("invalid_config_changes");
    if (change.remove) target.splice(Number(key), 1);
    else target[Number(key)] = change.value;
  } else if (change.remove) delete target[key];
  else target[key] = change.value;
}

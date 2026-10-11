import { defineConfig } from "@synapse/runtime-config";
import { z } from "zod";

/** 容器能力只由部署者启用，模型不能更改镜像、隔离参数与资源限额 */
export const ContainerSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    image: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/)
      .default("python:3.13-slim"),
    timeoutMs: z.number().int().min(1000).max(300_000).default(120_000),
    memoryMiB: z.number().int().min(64).max(4096).default(512),
    workspaceMiB: z.number().int().min(16).max(1024).default(64),
    cpus: z.number().min(0.1).max(4).default(1),
    maxConcurrent: z.number().int().min(1).max(8).default(2),
    maxArtifacts: z.number().int().min(1).max(16).default(8),
    maxArtifactBytes: z.number().int().min(1024).max(10_485_760).default(5_242_880),
    maxTotalBytes: z.number().int().min(1024).max(20_971_520).default(10_485_760),
    maxLogBytes: z.number().int().min(256).max(65_536).default(8192),
    storageMaxBytes: z.number().int().min(1_048_576).max(10_737_418_240).default(268_435_456)
  })
  .strict();

/** 完成默认值和约束解析后的容器配置 */
export type ContainerSettings = z.infer<typeof ContainerSettingsSchema>;

/** 容器配置令牌，与网络工具配置独立维护 */
export const containerConfig = defineConfig({
  id: "container",
  defaults: ContainerSettingsSchema.parse({}),
  parse: (value: unknown) => ContainerSettingsSchema.parse(value)
});

/** 工件只接受单层文件名，避免容器路径与宿主存储路径混为一谈 */
export const ArtifactNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^/\\:]+$/)
  .refine(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    "工件名称不能包含控制字符"
  )
  .refine((value) => value !== "." && value !== ".." && !value.startsWith("."), "工件名称不能使用隐藏文件或相对目录");

/** 模型可以提交的文件生成任务，不接受任意 Docker 参数 */
export const ContainerWorkInputSchema = z
  .object({
    script: z.string().min(1).max(50_000),
    outputs: z
      .array(ArtifactNameSchema)
      .min(1)
      .max(16)
      .refine((names) => new Set(names).size === names.length, "输出文件名不能重复"),
    inputs: z.array(z.string().uuid()).max(16).default([])
  })
  .strict();

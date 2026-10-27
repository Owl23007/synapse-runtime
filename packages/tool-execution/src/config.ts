import { z } from "zod";

/** 按需容器执行配置，镜像由部署者预先构建以避免群聊请求触发隐式拉取 */
export const DockerToolSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    image: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/)
      .default("synapse-execution:local"),
    timeoutMs: z.number().int().min(1000).max(300_000).default(120_000),
    memoryMb: z.number().int().min(64).max(4096).default(512),
    cpus: z.number().positive().max(8).default(1),
    maxArtifactBytes: z.number().int().min(1024).max(20_000_000).default(10_000_000)
  })
  .strict();

/** 已校验的容器执行配置 */
export type DockerToolSettings = z.infer<typeof DockerToolSettingsSchema>;

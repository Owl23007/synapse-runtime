import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { ChannelOperationResult } from "@synapse/runtime-protocol";
import { z } from "zod";

/** 上传归属由真实请求与工件登记共同决定，不接受模型指定目标 */
export interface ArtifactDeliveryKey {
  readonly sessionId: string;
  readonly channelId: string;
  readonly groupId: string;
  readonly artifactId: string;
}

const receiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), fileId: z.string().optional() }),
  z.object({ status: z.enum(["failed", "unsupported", "uncertain"]), error: z.string() })
]);

/** 只读核对已落盘的上传回执，未决占位不会触发重传或被推测为成功 */
export function inspectArtifactDelivery(
  directory: string,
  key: ArtifactDeliveryKey
): ChannelOperationResult | undefined {
  const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
  const receipt = join(directory, `${id}.json`);
  if (existsSync(receipt)) {
    const info = lstatSync(receipt);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16_384) throw new Error("工件交付回执无效");
    const value = receiptSchema.parse(JSON.parse(readFileSync(receipt, "utf8")));
    return value.status === "succeeded"
      ? { status: "succeeded", ...(value.fileId === undefined ? {} : { fileId: value.fileId }) }
      : value;
  }
  if (existsSync(join(directory, `${id}.pending`)))
    return { status: "uncertain", error: "该工件已有未确认上传，请先核对群文件，当前未重复上传" };
  return undefined;
}

/** 在外部上传前落盘占位，跨调用与重启都不重复上传同一群的同一工件 */
export class ArtifactDeliveryStore {
  /** 回执独立于工具调用序号，防止模型在同一轮换一个调用 ID 再次上传 */
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** 返回已有平台回执，结果未知时保留人工核对边界 */
  async deliver(
    key: ArtifactDeliveryKey,
    upload: () => Promise<ChannelOperationResult>
  ): Promise<ChannelOperationResult> {
    const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    const receipt = join(this.directory, `${id}.json`);
    const pending = join(this.directory, `${id}.pending`);
    const existing = inspectArtifactDelivery(this.directory, key);
    if (existing !== undefined) return existing;
    try {
      writeFileSync(pending, JSON.stringify(key), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 上传可能仍在进行，也可能进程在获得平台回执前退出，均不能自动重试
      return { status: "uncertain", error: "该工件已有未确认上传，请先核对群文件，当前未重复上传" };
    }
    let result: ChannelOperationResult;
    try {
      result = await upload();
    } catch {
      result = { status: "uncertain", error: "群文件上传结果未知，当前未自动重试" };
    }
    const temporary = `${receipt}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(result), { flag: "wx", mode: 0o600 });
      renameSync(temporary, receipt);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return result;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { GroupFileUploadResult } from "@synapse/runtime-channel";
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

/** 在外部上传前落盘占位，跨调用与重启都不重复上传同一群的同一工件 */
export class ArtifactDeliveryStore {
  /** 回执独立于工具调用序号，防止模型在同一轮换一个调用 ID 再次上传 */
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** 返回已有平台回执，结果未知时保留人工核对边界 */
  async deliver(
    key: ArtifactDeliveryKey,
    upload: () => Promise<GroupFileUploadResult>
  ): Promise<GroupFileUploadResult> {
    const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    const receipt = join(this.directory, `${id}.json`);
    const pending = join(this.directory, `${id}.pending`);
    if (existsSync(receipt)) {
      const existing = receiptSchema.parse(JSON.parse(readFileSync(receipt, "utf8")));
      return existing.status === "succeeded"
        ? { status: "succeeded", ...(existing.fileId === undefined ? {} : { fileId: existing.fileId }) }
        : existing;
    }
    try {
      writeFileSync(pending, JSON.stringify(key), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 上传可能仍在进行，也可能进程在获得平台回执前退出，均不能自动重试
      return { status: "uncertain", error: "该工件已有未确认上传，请先核对群文件，当前未重复上传" };
    }
    let result: GroupFileUploadResult;
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

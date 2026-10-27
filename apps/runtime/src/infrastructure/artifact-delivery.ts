import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { ChannelOperationResult } from "@synapse/runtime-protocol";
import {
  artifactDeliveryIdentity,
  resolveArtifactReceipt,
  deliverArtifact,
  type ArtifactDeliveryKey,
  type ArtifactDeliveryRecord,
  type ArtifactDeliveryReceipts
} from "@synapse/runtime-core/artifacts";
import { z } from "zod";

const receiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), fileId: z.string().optional() }),
  z.object({ status: z.enum(["failed", "unsupported", "uncertain"]), error: z.string() })
]);

function readRecord(directory: string, key: ArtifactDeliveryKey): ArtifactDeliveryRecord | undefined {
  const id = artifactDeliveryIdentity(key);
  const receipt = join(directory, `${id}.json`);
  if (existsSync(receipt)) {
    const info = lstatSync(receipt);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16_384) throw new Error("工件交付回执无效");
    const value = receiptSchema.parse(JSON.parse(readFileSync(receipt, "utf8")));
    return value.status === "succeeded"
      ? { status: "succeeded", ...(value.fileId === undefined ? {} : { fileId: value.fileId }) }
      : value;
  }
  if (existsSync(join(directory, `${id}.pending`))) return { status: "pending" };
  return undefined;
}

/** 只读核对持久回执，未决占位的业务含义由 Runtime 用例解释 */
export function inspectArtifactDelivery(
  directory: string,
  key: ArtifactDeliveryKey
): ChannelOperationResult | undefined {
  return resolveArtifactReceipt(readRecord(directory, key));
}

/** 原子回执文件实现，不负责决定重试、恢复或平台动作身份 */
export class ArtifactDeliveryStore implements ArtifactDeliveryReceipts {
  /** 回执目录由 App 的部署配置派生 */
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** 按领域身份读取终态或原始占位 */
  get(key: ArtifactDeliveryKey): ArtifactDeliveryRecord | undefined {
    return readRecord(this.directory, key);
  }

  /** 在外部副作用前以独占创建落盘占位 */
  claim(key: ArtifactDeliveryKey): boolean {
    const pending = join(this.directory, `${artifactDeliveryIdentity(key)}.pending`);
    try {
      writeFileSync(pending, JSON.stringify(key), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  }

  /** 原子替换回执，写入失败时保留占位 */
  complete(key: ArtifactDeliveryKey, result: ChannelOperationResult): void {
    const receipt = join(this.directory, `${artifactDeliveryIdentity(key)}.json`);
    const temporary = `${receipt}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(result), { flag: "wx", mode: 0o600 });
      renameSync(temporary, receipt);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /** 兼容原调用入口，交付状态推进委托给唯一的 Runtime 业务实现 */
  deliver(key: ArtifactDeliveryKey, upload: () => Promise<ChannelOperationResult>): Promise<ChannelOperationResult> {
    return deliverArtifact(this, key, upload);
  }
}

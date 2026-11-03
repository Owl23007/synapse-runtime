import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AutonomySettings } from "../config.js";
import type { RunTraceStore } from "../trace/types.js";

/** 文件级存储实现共用连接、预算和校验，不创建额外事务所有者 */
export interface ExecutionStorageContext {
  readonly db: Database.Database;
  readonly runs: RunTraceStore;
  readonly settings: AutonomySettings;
  readonly assertCapacity: () => void;
  readonly checkRecord: (value: unknown) => void;
  readonly checkText: (value: string) => void;
}

/** 宿主限额拒绝可与普通执行失败区分，调度不会因此丢弃已接受工作 */
export class ExecutionLimitError extends Error {
  /** 保存限额来源供调度选择停止或等待 */
  constructor(
    readonly kind: "capacity" | "rate" | "grant" | "storage",
    message: string
  ) {
    super(message);
  }
}

/** 领域记录的 SQLite JSON 行 */
export type Row = { record: string };

/** 将可选 SQLite 行解码为领域事实 */
export const unpack = <T>(row: Row | undefined): T | undefined => (row ? (JSON.parse(row.record) as T) : undefined);

/** 固定对象键顺序，幂等比较不受属性插入顺序影响 */
export const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item
  );

/** 从可信作用域和逻辑键派生稳定身份 */
export const keyId = (kind: string, values: unknown): string =>
  `${kind}:${createHash("sha256").update(stable(values)).digest("hex")}`;

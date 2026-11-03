import type { ExecutionStorageContext } from "./records.js";
import type { OutputIntent } from "./types.js";
import { stable } from "./records.js";

/** 操作回执、运行产出与累计调用额度存储，所有变更仍使用宿主共享连接 */
export function createOperationStorage(context: ExecutionStorageContext) {
  const methods = {
    /** 已提交结果独立于消息交付，崩溃后只重做缺失交付 */
    saveResult(runId: string, outcome: OutputIntent): void {
      context.checkRecord(outcome);
      const prior = methods.result(runId);
      if (prior && stable(prior) !== stable(outcome)) throw new Error("Execution result conflict");
      context.db
        .prepare("INSERT OR IGNORE INTO execution_results VALUES (?, ?, ?)")
        .run(runId, stable(outcome), Date.now());
    },

    /** 读取权威执行结果，不从已发送消息反向猜测结果 */
    result(runId: string): OutputIntent | undefined {
      const row = context.db.prepare("SELECT outcome FROM execution_results WHERE run_id = ?").get(runId) as
        | { outcome: string }
        | undefined;
      return row ? (JSON.parse(row.outcome) as OutputIntent) : undefined;
    },

    /** 开始副作用前保存稳定操作身份，未知结果不得作为缺失重放 */
    startOperation(
      runId: string,
      id: string,
      name: string,
      input: unknown,
      effect: "external" | "transactional" | "read" = "external"
    ): void {
      context.checkRecord(input);
      const existing = context.db
        .prepare("SELECT run_id, name, input, state, effect FROM execution_operations WHERE id = ?")
        .get(id) as { run_id: string; name: string; input: string; state: string; effect: string } | undefined;
      if (existing) {
        if (existing.run_id !== runId || existing.name !== name || existing.input !== stable(input))
          throw new Error("Operation identity conflict");
        if (existing.state === "started" && existing.effect === effect && effect !== "external") return;
        throw new Error("Operation already exists; reconcile before executing");
      }
      context.db
        .prepare("INSERT INTO execution_operations VALUES (?, ?, ?, ?, ?, 'started', NULL, ?)")
        .run(id, runId, name, stable(input), effect, Date.now());
    },

    /** 本地工具的变更与回执同事务提交，没有回执即没有已提交的本地变更 */
    transactionalTool(id: string, execute: () => unknown): unknown {
      return context.db
        .transaction(() => {
          const operation = methods.operation(id);
          if (!operation || operation.effect === "external") throw new Error("Transactional operation required");
          const result = execute();
          if (result && typeof result === "object" && "then" in result)
            throw new Error("Async work is forbidden in a database transaction");
          methods.receipt(id, "succeeded", result ?? null);
          return result;
        })
        .immediate();
    },

    /** 单 Run 的模型与工具额度跨 Attempt 累计，重启不会重置资源预算 */
    consume(runId: string, kind: "model" | "tool"): void {
      context.assertCapacity();
      if (methods.result(runId)) throw new Error("Execution outcome already committed");
      context.db
        .transaction(() => {
          context.db.prepare("INSERT OR IGNORE INTO execution_usage(run_id) VALUES (?)").run(runId);
          const usage = context.db
            .prepare("SELECT model_calls, tool_calls FROM execution_usage WHERE run_id = ?")
            .get(runId) as { model_calls: number; tool_calls: number };
          if (
            kind === "model"
              ? usage.model_calls >= context.settings.maxModelCallsPerRun
              : usage.tool_calls >= context.settings.maxToolCallsPerRun
          )
            throw new Error(`Run ${kind} budget exhausted`);
          context.db
            .prepare(
              kind === "model"
                ? "UPDATE execution_usage SET model_calls = model_calls + 1 WHERE run_id = ?"
                : "UPDATE execution_usage SET tool_calls = tool_calls + 1 WHERE run_id = ?"
            )
            .run(runId);
        })
        .immediate();
    },

    /** 保存确定回执；超时或中断作为未知事实，不假定外部动作失败 */
    receipt(id: string, state: "succeeded" | "failed" | "blocked" | "uncertain", result: unknown): void {
      context.checkRecord(result);
      const row = context.db.prepare("SELECT state, result FROM execution_operations WHERE id = ?").get(id) as
        | { state: string; result: string | null }
        | undefined;
      if (!row) throw new Error("Operation not found");
      if (!["started", "uncertain"].includes(row.state)) {
        if (row.state !== state || row.result !== stable(result)) throw new Error("Receipt conflict");
        return;
      }
      context.db
        .prepare("UPDATE execution_operations SET state = ?, result = ? WHERE id = ?")
        .run(state, stable(result), id);
    },

    /** 精确索引读取操作与回执，不扫描整条会话日志 */
    operation(id: string):
      | {
          runId: string;
          name: string;
          input: unknown;
          state: string;
          effect: "external" | "transactional" | "read";
          result: unknown;
        }
      | undefined {
      const row = context.db
        .prepare("SELECT run_id, name, input, state, effect, result FROM execution_operations WHERE id = ?")
        .get(id) as
        | {
            run_id: string;
            name: string;
            input: string;
            state: string;
            effect: "external" | "transactional" | "read";
            result: string | null;
          }
        | undefined;
      return row
        ? {
            runId: row.run_id,
            name: row.name,
            input: JSON.parse(row.input),
            state: row.state,
            effect: row.effect,
            result: row.result ? JSON.parse(row.result) : null
          }
        : undefined;
    }
  };
  return methods;
}

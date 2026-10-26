import { randomUUID } from "node:crypto";
import type { AppendRunEventInput, RunEventType, RunTraceStore } from "./types.js";
import { RunOutcome } from "./outcome.js";

/** 将当前尝试的观察事实归并为终态，消息发送成功不会掩盖模型或上传失败 */
export class RunRecorder {
  readonly attemptId = `attempt-${randomUUID()}`;
  readonly #outcome = new RunOutcome();
  #sequence = 0;
  #writeFailed = false;

  /** 在开始执行前持久化本次尝试身份 */
  constructor(
    readonly runId: string,
    private readonly store: RunTraceStore
  ) {
    const run = store.get(runId);
    store.append(runId, {
      key: this.attemptId,
      type: run?.status === "interrupted" ? "run_resumed" : "run_started",
      status: "running",
      phase: "context",
      attemptId: this.attemptId
    });
  }

  /** 记录脱敏事实，写入失败后阻止该尝试继续执行 */
  emit(type: RunEventType, data: unknown = null, durationMs?: number): void {
    if (this.#writeFailed) throw new Error("Run trace persistence failed; execution is stopped");
    if (type === "tool_call_started" && this.#outcome.uncertain)
      throw new Error("Uncertain external action requires inspection before another tool may execute");
    const phase = type.startsWith("model_")
      ? "model"
      : type.startsWith("tool_") || type.startsWith("permission_")
        ? "tool"
        : type.startsWith("artifact_")
          ? "artifact"
          : type.startsWith("response_")
            ? "response"
            : "context";
    try {
      this.store.append(this.runId, {
        key: `${this.attemptId}:${++this.#sequence}`,
        type,
        attemptId: this.attemptId,
        phase,
        data,
        ...(durationMs === undefined ? {} : { durationMs })
      });
    } catch (error) {
      this.#writeFailed = true;
      throw error;
    }
    this.#outcome.observe(type, data);
  }

  /** 记录请求级失败，未知副作用优先于其他错误 */
  fail(status: "failed" | "blocked" | "uncertain", code: string, message: string, phase = "runtime"): void {
    this.#outcome.fail(status, code, message, phase);
  }

  /** 仅在执行与发送均结束后生成终态，未决动作必须保守处理 */
  finish(): void {
    if (this.#writeFailed) this.#outcome.fail("uncertain", "trace_write_failed", "运行事实写入失败，请核对外部结果");
    const { status, error } = this.#outcome.result();
    const type: AppendRunEventInput["type"] =
      status === "succeeded"
        ? "run_succeeded"
        : status === "failed"
          ? "run_failed"
          : status === "blocked"
            ? "run_blocked"
            : status === "uncertain"
              ? "run_uncertain"
              : "run_interrupted";
    this.store.append(this.runId, {
      key: `${this.attemptId}:finished`,
      type,
      status,
      phase: "finished",
      attemptId: this.attemptId,
      ...(error === undefined ? {} : { error })
    });
  }
}

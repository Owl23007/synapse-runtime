import { randomUUID } from "node:crypto";
import type { AppendRunEventInput, RunError, RunEventType, RunStatus, RunTraceStore } from "./types.js";

/** 将当前尝试的观察事实归并为终态，消息发送成功不会掩盖模型或上传失败 */
export class RunRecorder {
  readonly attemptId = `attempt-${randomUUID()}`;
  readonly #pending = new Set<string>();
  #sequence = 0;
  #delivered = false;
  #failure: { status: "failed" | "blocked" | "uncertain"; error: RunError } | undefined;
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
    if (type === "tool_call_started" && this.#failure?.status === "uncertain")
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
    const record = data as { callId?: string; message?: string } | null;
    if (type === "tool_call_started") this.#pending.add(`tool:${record?.callId}`);
    if (["tool_call_succeeded", "tool_call_failed", "tool_call_blocked"].includes(type))
      this.#pending.delete(`tool:${record?.callId}`);
    if (type === "response_sending") this.#pending.add("response");
    if (["response_sent", "response_send_failed"].includes(type)) this.#pending.delete("response");
    if (type === "response_sent") this.#delivered = true;
    if (type === "model_call_failed" || type === "artifact_upload_failed" || type === "response_send_failed")
      this.fail("failed", type, record?.message ?? "执行失败", phase);
    if (type === "artifact_upload_uncertain" || type === "response_send_uncertain")
      this.fail("uncertain", type, "外部动作结果未知，未自动重放", phase);
  }

  /** 记录请求级失败，未知副作用优先于其他错误 */
  fail(status: "failed" | "blocked" | "uncertain", code: string, message: string, phase = "runtime"): void {
    if (this.#failure?.status === "uncertain") return;
    this.#failure = { status, error: { code, message, phase } };
  }

  /** 仅在执行与发送均结束后生成终态，未决动作必须保守处理 */
  finish(): void {
    const status: RunStatus =
      this.#pending.size > 0 || this.#writeFailed
        ? "uncertain"
        : (this.#failure?.status ?? (this.#delivered ? "succeeded" : "interrupted"));
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
      ...(this.#failure === undefined ? {} : { error: this.#failure.error })
    });
  }
}

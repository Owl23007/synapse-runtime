import type { RunError, RunEventType, RunStatus } from "./types.js";

/** 共享实时执行与崩溃恢复的结果归并，回复成功不能覆盖未决副作用 */
export class RunOutcome {
  readonly #pending = new Set<string>();
  readonly #generated = new Set<string>();
  readonly #uploaded = new Set<string>();
  #selected: Set<string> | undefined;
  #delivered = false;
  #containerFailed = false;
  #failure: { status: "failed" | "blocked" | "uncertain"; error: RunError } | undefined;

  /** 根据已提交事实维护调用配对与交付状态 */
  observe(type: RunEventType, value: unknown): void {
    const data = record(value);
    const key = `tool:${String(data.callId)}`;
    if (type === "tool_call_started") this.#pending.add(key);
    if (["tool_call_succeeded", "tool_call_failed", "tool_call_blocked"].includes(type)) this.#pending.delete(key);
    if (type === "response_sending") this.#pending.add("response");
    if (["response_sent", "response_send_failed"].includes(type)) this.#pending.delete("response");
    if (type === "response_sent") {
      this.#delivered = true;
      if (Array.isArray(data.artifactIds))
        for (const id of data.artifactIds) if (typeof id === "string") this.#uploaded.add(id);
    }
    if (type === "model_call_failed" || type === "artifact_upload_failed" || type === "response_send_failed")
      this.fail("failed", type, typeof data.message === "string" ? data.message : "执行失败");
    if (type === "artifact_upload_uncertain" || type === "response_send_uncertain")
      this.fail("uncertain", type, "外部动作结果未知，未自动重放");
    if (type === "tool_call_failed" && record(data.error).name === "ToolCallRecoveryError")
      this.fail("uncertain", "tool_outcome_uncertain", "工具执行已中止，外部结果未确认");
    if (type === "artifact_created") this.#addArtifact(data.artifact);
    if (type === "artifact_selection_changed") this.#select(data);
    if (type === "artifact_upload_succeeded" && typeof data.artifactId === "string")
      this.#uploaded.add(data.artifactId);
    // 工具回执先于派生工件事件落盘，恢复时可直接从回执补足结果
    if (type === "tool_call_succeeded") {
      const raw = record(data.output);
      const output = raw.schemaVersion === "runtime-tool-output/v1" ? record(raw.modelOutput) : raw;
      if (data.name === "container.run" || data.name === "docker.run") {
        if (output.status === "failed" || output.status === "generated")
          this.#containerFailed = output.status === "failed";
        if (Array.isArray(output.artifacts)) for (const artifact of output.artifacts) this.#addArtifact(artifact);
      }
      if (["container.run", "docker.run", "artifact.upload"].includes(String(data.name)))
        this.#select(record(output.selection));
      if (data.name === "artifact.upload") {
        if (output.status === "selected" || output.status === "discarded") return;
        if (output.status === "succeeded" && typeof output.artifactId === "string")
          this.#uploaded.add(output.artifactId);
        else
          this.fail(
            output.status === "uncertain" ? "uncertain" : "failed",
            "artifact_upload_failed",
            "工件交付未确认成功"
          );
      }
    }
  }

  /** 未知结果优先于其他失败，禁止后续事实把它误改为成功 */
  fail(status: "failed" | "blocked" | "uncertain", code: string, message: string, phase = "runtime"): void {
    if (this.#failure?.status === "uncertain") return;
    this.#failure = { status, error: { code, message, phase } };
  }

  /** 未确认结果是否已经阻止继续执行工具 */
  get uncertain(): boolean {
    return this.#failure?.status === "uncertain";
  }

  /** 基于已知事实计算终态，没有回复回执时不猜测完成 */
  result(): { readonly status: Exclude<RunStatus, "accepted" | "running">; readonly error?: RunError } {
    if (this.#pending.size > 0)
      return {
        status: "uncertain",
        error: { code: "pending_action", message: "外部动作结果未确认，请人工核对，未自动重放", phase: "recovery" }
      };
    if (this.#failure) return this.#failure;
    if (this.#containerFailed)
      return {
        status: "failed",
        error: { code: "container_failed", message: "容器生成失败，尚无成功修正结果", phase: "tool" }
      };
    if (this.#delivered && [...(this.#selected ?? this.#generated)].some((id) => !this.#uploaded.has(id)))
      return {
        status: "failed",
        error: { code: "artifact_not_delivered", message: "已生成工件尚无成功上传回执", phase: "artifact" }
      };
    return this.#delivered
      ? { status: "succeeded" }
      : {
          status: "interrupted",
          error: { code: "interrupted", message: "运行进程中断，已保留历史记录", phase: "runtime" }
        };
  }

  #addArtifact(value: unknown): void {
    const artifact = record(value);
    if (typeof artifact.id === "string") this.#generated.add(artifact.id);
  }

  #select(data: Record<string, unknown>): void {
    if (Array.isArray(data.selectedIds) && data.selectedIds.every((id) => typeof id === "string"))
      this.#selected = new Set(data.selectedIds);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

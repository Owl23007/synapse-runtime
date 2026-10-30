import { describe, expect, it } from "vitest";
import { RunOutcome } from "../../../src/trace/outcome.js";

describe("最终工件与运行终态", () => {
  it("明确失败的草稿被废弃后，成功交付最终文件可以完成运行", () => {
    const outcome = new RunOutcome();
    outcome.observe("artifact_created", { artifact: { id: "draft" } });
    outcome.observe("artifact_upload_failed", { artifactId: "draft" });
    outcome.observe("artifact_created", { artifact: { id: "final" } });
    outcome.observe("artifact_selection_changed", { selectedIds: ["final"], discardedIds: ["draft"] });
    outcome.observe("artifact_upload_succeeded", { artifactId: "final" });
    outcome.observe("response_sent", {});
    expect(outcome.result().status).toBe("succeeded");
  });

  it("不能通过废弃未知上传或清空选择绕过人工核对", () => {
    const outcome = new RunOutcome();
    outcome.observe("artifact_upload_uncertain", { artifactId: "unknown" });
    outcome.observe("artifact_selection_changed", { selectedIds: [], discardedIds: ["unknown"] });
    outcome.observe("response_sent", {});
    expect(outcome.result().status).toBe("uncertain");
  });

  it("选择和本地生成不能冒充交付，旧工件上传失败同样阻断完成", () => {
    const generated = new RunOutcome();
    generated.observe("artifact_selection_changed", { selectedIds: ["file"] });
    generated.observe("response_sent", {});
    expect(generated.result()).toMatchObject({ status: "failed", error: { code: "artifact_not_delivered" } });
    const failed = new RunOutcome();
    failed.observe("tool_call_succeeded", {
      name: "artifact.upload",
      output: { status: "failed", artifactId: "old-file" }
    });
    failed.observe("response_sent", {});
    expect(failed.result().status).toBe("failed");
  });
});

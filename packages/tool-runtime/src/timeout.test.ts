import { describe, expect, it } from "vitest";
import { ToolRuntime } from "./runtime.js";
import type { ToolRuntimeEvent } from "./types.js";

describe("工具截止边界", () => {
  it("超时保留未知结果，迟到成功不再落库，后续调用被停止", async () => {
    const tools = new ToolRuntime({ decide: async (request) => ({ ...request, decision: "allow" }) });
    let finish = (_value: string) => {};
    let signal: AbortSignal | undefined;
    tools.register({
      name: "external",
      description: "External",
      permission: { action: "send", resource: "test" },
      handle: (_input, context) => {
        signal = context.signal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      }
    });
    const events: ToolRuntimeEvent[] = [];
    tools.addObserver((event) => {
      events.push(event);
    });
    const scope = tools.withContext({ sessionId: "session", userId: "user", timeoutMs: 25 });
    await expect(scope.call("external", {}, { runId: "run" })).rejects.toMatchObject({ code: "outcome_uncertain" });
    expect(signal?.aborted).toBe(true);
    finish("late");
    await tools.drain(100);
    expect(events.map((event) => event.type)).toEqual(["tool_call_started", "tool_call_failed"]);
    await expect(scope.call("external", {}, { runId: "run" })).rejects.toMatchObject({ code: "scope_halted" });
  });
});

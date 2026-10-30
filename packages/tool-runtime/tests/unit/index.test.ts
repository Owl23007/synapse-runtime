import { describe, expect, it } from "vitest";
import type { PermissionEngine, PermissionRequest } from "@synapse/runtime-permission";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import {
  ToolCallRecoveryError,
  ToolRuntime,
  describeToolSet,
  type ToolCallContext,
  type ToolContext,
  type ToolRuntimeEvent,
  type ToolRuntimeObserver
} from "../../src/index.js";

const BASE_CONTEXT: ToolContext = {
  runId: "run-1",
  sessionId: "session-1",
  userId: "user-1"
};

describe("工具集描述", () => {
  it("工具与模式属性顺序变化时保持稳定", () => {
    const first = describeToolSet([
      {
        name: "b",
        description: "B",
        inputSchema: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } },
        permission: { action: "b", resource: "b" },
        async handle() {}
      },
      {
        name: "a",
        description: "A",
        permission: { action: "a", resource: "a" },
        async handle() {}
      }
    ]);
    const second = describeToolSet([
      {
        name: "a",
        description: "A",
        permission: { action: "a", resource: "a" },
        async handle() {}
      },
      {
        name: "b",
        description: "B",
        inputSchema: { properties: { a: { type: "number" }, z: { type: "string" } }, type: "object" },
        permission: { action: "b", resource: "b" },
        async handle() {}
      }
    ]);

    expect(first.toolIds).toEqual(["a", "b"]);
    expect(first.digest).toBe(second.digest);
  });
});

describe("工具运行时契约", () => {
  it("从工具输入解析权限资源", async () => {
    const requests: PermissionRequest[] = [];
    const runtime = new ToolRuntime({
      async decide(request) {
        requests.push(request);
        return {
          action: request.action,
          resource: request.resource,
          decision: "allow"
        };
      }
    });
    runtime.register({
      name: "web.fetch",
      description: "Fetch a web page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" }
        },
        required: ["url"],
        additionalProperties: false
      },
      permission(input) {
        const url = (input as { readonly url: string }).url;
        return {
          action: "network.web.fetch",
          resource: new URL(url).hostname
        };
      },
      async handle() {
        return "content";
      }
    });

    await expect(
      runtime.call("web.fetch", { url: "https://docs.example.com/guide" }, BASE_CONTEXT)
    ).resolves.toMatchObject({
      status: "succeeded",
      output: "content"
    });
    expect(requests).toEqual([
      {
        action: "network.web.fetch",
        resource: "docs.example.com",
        subject: "user-1"
      }
    ]);
    expect(runtime.list()[0]?.inputSchema).toMatchObject({
      required: ["url"]
    });
  });
});

describe("工具运行时观察者", () => {
  it("按订阅顺序等待观察者并保留传入的调用作用域", async () => {
    const order: string[] = [];
    const events: ToolRuntimeEvent[] = [];
    let handlerContext: ToolContext | undefined;
    const permissionEngine: PermissionEngine = {
      async decide(request) {
        order.push("permission");
        return { ...request, decision: "allow" };
      }
    };
    const runtime = new ToolRuntime(permissionEngine);
    runtime.register({
      name: "echo",
      description: "Echo the input.",
      permission: { action: "tool.echo", resource: "echo" },
      async handle(input, context) {
        order.push("handler");
        handlerContext = context;
        return { echoed: input };
      }
    });
    runtime.addObserver(async (event) => {
      order.push(`observer-1:${event.type}:start`);
      await Promise.resolve();
      events.push(event);
      order.push(`observer-1:${event.type}:end`);
    });
    runtime.addObserver((event) => {
      order.push(`observer-2:${event.type}`);
    });
    const context: ToolContext = {
      ...BASE_CONTEXT,
      lineId: "line-1",
      branchId: "branch-1",
      taskId: "task-1",
      causationEventId: "event-1",
      callId: "call-explicit"
    };

    const result = await runtime.call<{ readonly echoed: unknown }>("echo", { value: 42 }, context);

    expect(result).toEqual({ status: "succeeded", output: { echoed: { value: 42 } } });
    expect(handlerContext).toEqual(context);
    expect(events).toMatchObject([
      {
        type: "tool_call_started",
        name: "echo",
        input: { value: 42 },
        context,
        occurredAt: expect.any(String)
      },
      {
        type: "tool_call_succeeded",
        name: "echo",
        input: { value: 42 },
        output: { echoed: { value: 42 } },
        context,
        occurredAt: expect.any(String)
      }
    ]);
    expect(order).toEqual([
      "observer-1:tool_call_started:start",
      "observer-1:tool_call_started:end",
      "observer-2:tool_call_started",
      "permission",
      "handler",
      "observer-1:tool_call_succeeded:start",
      "observer-1:tool_call_succeeded:end",
      "observer-2:tool_call_succeeded"
    ]);
  });

  it("每次调用生成一个调用标识并在处理器与所有事件中复用", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.echo": "allow" }));
    const events: ToolRuntimeEvent[] = [];
    let handlerContext: ToolContext | undefined;
    runtime.register({
      name: "echo",
      description: "Echo the input.",
      permission: { action: "tool.echo", resource: "echo" },
      async handle(input, context) {
        handlerContext = context;
        return input;
      }
    });
    runtime.addObserver((event) => {
      events.push(event);
    });

    await runtime.call("echo", "hello", BASE_CONTEXT);

    const callIds = [
      ...events.map((event) => event.context.callId),
      ...(handlerContext?.callId === undefined ? [] : [handlerContext.callId])
    ];
    expect(callIds).toHaveLength(3);
    expect(new Set(callIds).size).toBe(1);
    expect(callIds[0]).toMatch(/^tool-call-[0-9a-f-]{36}$/);
  });

  it("启动观察者失败时不检查权限或执行处理器", async () => {
    let permissionCalls = 0;
    let handlerCalls = 0;
    const observerCalls: string[] = [];
    const observerError = new Error("event persistence unavailable");
    const permissionEngine: PermissionEngine = {
      async decide(request) {
        permissionCalls += 1;
        return { ...request, decision: "allow" };
      }
    };
    const runtime = new ToolRuntime(permissionEngine);
    runtime.register({
      name: "dangerous",
      description: "Must not run.",
      permission: { action: "tool.dangerous", resource: "dangerous" },
      async handle() {
        handlerCalls += 1;
        return "unexpected";
      }
    });
    runtime.addObserver(() => {
      observerCalls.push("first");
      throw observerError;
    });
    runtime.addObserver(() => {
      observerCalls.push("second");
    });

    await expect(runtime.call("dangerous", {}, BASE_CONTEXT)).rejects.toBe(observerError);
    expect(permissionCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(observerCalls).toEqual(["first"]);
  });

  it("发出阻止事件且不执行处理器", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.write": "confirm" }));
    const events: ToolRuntimeEvent[] = [];
    let handlerCalls = 0;
    runtime.register({
      name: "write",
      description: "Write something.",
      permission: { action: "tool.write", resource: "file" },
      async handle() {
        handlerCalls += 1;
        return undefined;
      }
    });
    runtime.addObserver((event) => {
      events.push(event);
    });

    const result = await runtime.call("write", { path: "file.txt" }, { ...BASE_CONTEXT, callId: "call-blocked" });

    expect(result).toEqual({
      status: "blocked",
      reason: 'Permission decision was "confirm".'
    });
    expect(handlerCalls).toBe(0);
    expect(events).toMatchObject([
      { type: "tool_call_started", context: { callId: "call-blocked" } },
      {
        type: "tool_call_blocked",
        reason: 'Permission decision was "confirm".',
        context: { callId: "call-blocked" }
      }
    ]);
  });

  it("发出失败事件并重新抛出原始处理器错误", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.fail": "allow" }));
    const events: ToolRuntimeEvent[] = [];
    const handlerError = new Error("handler exploded");
    runtime.register({
      name: "fail",
      description: "Fail.",
      permission: { action: "tool.fail", resource: "failure" },
      async handle() {
        throw handlerError;
      }
    });
    runtime.addObserver((event) => {
      events.push(event);
    });

    await expect(runtime.call("fail", "input", BASE_CONTEXT)).rejects.toBe(handlerError);
    expect(events.map((event) => event.type)).toEqual(["tool_call_started", "tool_call_failed"]);
    const failed = events[1];
    expect(failed).toMatchObject({
      type: "tool_call_failed",
      name: "fail",
      input: "input",
      error: handlerError,
      context: { runId: "run-1", sessionId: "session-1", userId: "user-1", callId: expect.any(String) },
      occurredAt: expect.any(String)
    });
  });

  it("权限评估抛出异常时发出失败事件", async () => {
    const permissionError = new Error("permission backend unavailable");
    const permissionEngine: PermissionEngine = {
      async decide() {
        throw permissionError;
      }
    };
    const runtime = new ToolRuntime(permissionEngine);
    const events: ToolRuntimeEvent[] = [];
    let handlerCalls = 0;
    runtime.register({
      name: "read",
      description: "Read.",
      permission: { action: "tool.read", resource: "file" },
      async handle() {
        handlerCalls += 1;
        return "unexpected";
      }
    });
    runtime.addObserver((event) => {
      events.push(event);
    });

    await expect(runtime.call("read", undefined, BASE_CONTEXT)).rejects.toBe(permissionError);
    expect(handlerCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["tool_call_started", "tool_call_failed"]);
    expect(events[1]).toMatchObject({ type: "tool_call_failed", error: permissionError });
  });

  it("返回幂等取消订阅函数", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.echo": "allow" }));
    const seen: string[] = [];
    runtime.register({
      name: "echo",
      description: "Echo.",
      permission: { action: "tool.echo", resource: "echo" },
      async handle(input) {
        return input;
      }
    });
    const observer: ToolRuntimeObserver = (event) => {
      seen.push(event.type);
    };
    const unsubscribe = runtime.addObserver(observer);
    unsubscribe();
    unsubscribe();

    await runtime.call("echo", "hello", BASE_CONTEXT);

    expect(seen).toEqual([]);
  });

  it("绑定代理调用作用域使缺失或冲突的分支字段无法逃逸", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.echo": "allow" }));
    const events: ToolRuntimeEvent[] = [];
    runtime.register({
      name: "echo",
      description: "Echo.",
      permission: { action: "tool.echo", resource: "echo" },
      async handle(input) {
        return input;
      }
    });
    runtime.addObserver((event) => {
      events.push(event);
    });
    const branchTools = runtime.withContext({
      sessionId: "session-branch",
      userId: "user-branch",
      lineId: "branch-1",
      branchId: "branch-1",
      causationEventId: "event-source"
    });

    const conflictingContext = {
      runId: "run-branch",
      lineId: "mainline-1"
    };
    await branchTools.call("echo", "hello", conflictingContext);

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.context.lineId === "branch-1")).toBe(true);
    expect(events.every((event) => event.context.branchId === "branch-1")).toBe(true);
    expect(events.every((event) => event.context.sessionId === "session-branch")).toBe(true);
    expect(events.every((event) => event.context.causationEventId === "event-source")).toBe(true);
  });

  it("不允许主线作用域调用者注入分支或任务所有权", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.echo": "allow" }));
    let handlerContext: ToolContext | undefined;
    runtime.register({
      name: "echo",
      description: "Echo.",
      permission: { action: "tool.echo", resource: "echo" },
      async handle(input, context) {
        handlerContext = context;
        return input;
      }
    });
    const mainlineTools = runtime.withContext({
      sessionId: "session-mainline",
      userId: "user-mainline",
      lineId: "mainline-1",
      causationEventId: "event-source"
    });

    const forgedContext = {
      runId: "run-mainline",
      sessionId: "forged-session",
      userId: "forged-user",
      lineId: "forged-line",
      branchId: "forged-branch",
      taskId: "forged-task",
      causationEventId: "forged-event"
    };
    await mainlineTools.call("echo", "hello", forgedContext);

    expect(handlerContext).toEqual({
      runId: "run-mainline",
      sessionId: "session-mainline",
      userId: "user-mainline",
      lineId: "mainline-1",
      causationEventId: "event-source",
      callId: expect.any(String)
    });
  });

  it("使用确定性作用域调用标识并重放持久结果且不执行处理器", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.echo": "allow" }));
    const observed: ToolRuntimeEvent[] = [];
    let handlerCalls = 0;
    runtime.register({
      name: "echo",
      description: "Echo.",
      permission: { action: "tool.echo", resource: "echo" },
      async handle(input) {
        handlerCalls += 1;
        return input;
      }
    });
    runtime.addObserver((event) => {
      observed.push(event);
    });
    const tools = runtime.withContext({
      sessionId: "session-durable",
      userId: "user-durable",
      durableCallIdPrefix: "normalized-event-1",
      async replayCall(request) {
        expect(request.context.callId).toBe("tool-call:normalized-event-1:1");
        return { status: "succeeded", output: { cached: true } };
      }
    });

    await expect(tools.call("echo", { value: 1 }, { runId: "retry-run" })).resolves.toEqual({
      status: "succeeded",
      output: { cached: true }
    });
    expect(handlerCalls).toBe(0);
    expect(observed).toEqual([]);
  });

  it("先前工具结果不确定时停止作用域运行时", async () => {
    const runtime = new ToolRuntime(new StaticPermissionEngine({ "tool.write": "allow" }));
    let handlerCalls = 0;
    let replayCalls = 0;
    runtime.register({
      name: "write",
      description: "Write.",
      permission: { action: "tool.write", resource: "write" },
      async handle() {
        handlerCalls += 1;
        return "written";
      }
    });
    const tools = runtime.withContext({
      sessionId: "session-uncertain",
      userId: "user-uncertain",
      durableCallIdPrefix: "normalized-event-2",
      async replayCall() {
        replayCalls += 1;
        return { status: "started" };
      }
    });

    const firstCall = tools.call("write", {}, { runId: "retry-run" }).catch((error: unknown) => error);
    const queuedCall = tools.call("write", { second: true }, { runId: "retry-run" }).catch((error: unknown) => error);
    const [firstError, secondError] = await Promise.all([firstCall, queuedCall]);
    expect(firstError).toBeInstanceOf(ToolCallRecoveryError);
    expect(firstError).toMatchObject({ code: "outcome_uncertain" });

    expect(secondError).toBeInstanceOf(ToolCallRecoveryError);
    expect(secondError).toMatchObject({ code: "scope_halted" });
    expect(replayCalls).toBe(1);
    expect(handlerCalls).toBe(0);
  });

  it("在观察者上下文中按要求暴露生成的调用标识", () => {
    const context = {
      ...BASE_CONTEXT,
      callId: "call-1"
    } satisfies ToolCallContext;

    expect(context.callId).toBe("call-1");
  });
});

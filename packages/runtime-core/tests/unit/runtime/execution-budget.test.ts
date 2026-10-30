import { describe, expect, it } from "vitest";
import { ExecutionGate, withAbort } from "../../../src/runtime/execution-budget.js";

describe("运行容量和取消边界", () => {
  it("并发名额与排队容量不会在异步完成前提前释放", async () => {
    const gate = new ExecutionGate(1, 1);
    let release = () => {};
    const order: number[] = [];
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          order.push(1);
          release = resolve;
        })
    );
    const second = gate.run(async () => {
      order.push(2);
    });
    await expect(gate.run(async () => {})).rejects.toThrow("队列已满");
    expect(gate.status).toMatchObject({ active: 1, queued: 1, rejected: 1 });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });
  it("关闭时拒绝等待请求，活动请求仍可完成", async () => {
    const gate = new ExecutionGate(1, 1);
    let release = () => {};
    const active = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const queued = gate.run(async () => {});
    gate.close();
    await expect(queued).rejects.toThrow("未执行");
    release();
    await active;
    await expect(gate.run(async () => {})).rejects.toThrow("关闭");
  });
  it("截止后拒绝迟到的成功结果", async () => {
    const controller = new AbortController();
    let finish = (_value: string) => {};
    const underlying = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const pending = withAbort(underlying, controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    finish("late");
    await expect(underlying).resolves.toBe("late");
  });
});

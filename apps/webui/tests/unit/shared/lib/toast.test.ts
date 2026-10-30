import { describe, expect, it, vi } from "vitest";
import { createToastStore } from "../../../../src/shared/lib/toast.js";

describe("全局消息通道", () => {
  it("合并重复消息并替换标识，使重复操作重新获得完整阅读时间", () => {
    const store = createToastStore();
    const previous = store.success("已复制消息");
    const current = store.success("已复制消息");
    expect(current).not.toBe(previous);
    expect(store.getSnapshot()).toEqual([{ id: current, tone: "success", text: "已复制消息", duration: 3200 }]);
    store.dismiss(previous!);
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it("限制同时显示数量，同时保留相同文字的不同语义", () => {
    const store = createToastStore();
    store.info("第一条");
    store.success("操作结果");
    store.error("操作结果");
    store.warning("请检查配置");
    expect(store.getSnapshot().map((item) => item.tone)).toEqual(["success", "error", "warning"]);
    expect(store.getSnapshot()[1]?.duration).toBe(6000);
  });

  it("订阅取消后不再通知，快照只在消息变化时替换", () => {
    const store = createToastStore();
    const listener = vi.fn<() => void>();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    store.info("提示");
    expect(store.getSnapshot()).not.toBe(initial);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("忽略空白内容，允许常驻消息并修正无效时长", () => {
    const store = createToastStore();
    expect(store.info("  ")).toBeUndefined();
    expect(store.getSnapshot()).toHaveLength(0);
    store.warning("保持显示", { duration: 0 });
    store.error("无效时长", { duration: Number.NaN });
    expect(store.getSnapshot().map((item) => item.duration)).toEqual([0, 3200]);
  });
});

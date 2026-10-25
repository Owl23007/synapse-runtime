import type { AdminFetch } from "./admin-client-types.js";
import type { RunEvent, RunSnapshot, RunStreamOptions } from "./run-types.js";

/** 订阅带认证的持久 SSE，断线自动补读，退出时释放计时器与 reader */
export function subscribeRuns(
  fetch: AdminFetch,
  endpoint: string,
  token: string | undefined,
  options: RunStreamOptions
): () => void {
  const controller = new AbortController();
  let cursor = options.afterCursor;
  let retry = 0;
  const run = async () => {
    while (!controller.signal.aborted) {
      options.onState?.(retry === 0 ? "connecting" : "reconnecting");
      try {
        const response = await fetch(`${endpoint}/admin/run-events/stream`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...(cursor === undefined ? {} : { "last-event-id": String(cursor) })
          }
        });
        if (response.status === 401 || response.status === 403) {
          options.onState?.("unauthorized");
          options.onError?.(new Error("管理认证失败或来源未获授权"));
          return;
        }
        if (response.status === 409) {
          cursor = undefined;
          options.onReset?.();
          throw new Error("运行游标已失效，正在重新同步");
        }
        if (!response.ok || !response.body) throw new Error(`运行流连接失败：HTTP ${response.status}`);
        options.onState?.("connected");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (!controller.signal.aborted) {
            // 顺序消费并推进游标，避免回调尚未处理的事件被跳过
            // oxlint-disable-next-line no-await-in-loop
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 1_048_576) throw new Error("运行事件超过客户端读取上限");
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const lines = frame.split(/\r?\n/);
              const type = lines
                .find((line) => line.startsWith("event:"))
                ?.slice(6)
                .trim();
              const json = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!json) continue;
              const value = JSON.parse(json) as Record<string, unknown>;
              if (type === "reset") {
                cursor = undefined;
                options.onReset?.();
                throw new Error("运行服务已更换，正在重新同步");
              }
              if (type !== "snapshot" && type !== "run_event") continue;
              if (value.protocolVersion !== 1) {
                options.onState?.("incompatible");
                options.onError?.(new Error("不支持的运行追踪协议版本，请更新客户端"));
                return;
              }
              if (!Number.isSafeInteger(value.cursor) || Number(value.cursor) < 0) throw new Error("运行游标无效");
              if (type === "snapshot") {
                if (!Array.isArray(value.runs)) throw new Error("运行快照无效");
                options.onSnapshot?.(value as unknown as RunSnapshot);
                cursor ??= Number(value.cursor);
              } else {
                if (typeof value.runId !== "string" || typeof value.id !== "string" || !Number.isSafeInteger(value.seq))
                  throw new Error("运行事件无效");
                if (cursor !== undefined && Number(value.cursor) <= cursor) continue;
                options.onEvent(value as unknown as RunEvent);
                cursor = Number(value.cursor);
              }
              retry = 0;
            }
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (!controller.signal.aborted) throw new Error("运行流已断开");
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError?.(error instanceof Error ? error : new Error("运行流读取失败"));
      }
      if (!controller.signal.aborted) {
        options.onState?.("reconnecting");
        await wait(Math.min(500 * 2 ** Math.min(retry++, 5), 15_000), controller.signal);
      }
    }
  };
  void run().catch((error: unknown) => {
    if (!controller.signal.aborted) options.onError?.(error instanceof Error ? error : new Error("运行流失败"));
  });
  return () => {
    controller.abort();
    options.onState?.("stopped");
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

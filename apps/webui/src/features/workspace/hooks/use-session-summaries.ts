import { useEffect, useRef, useState } from "react";
import { type RuntimeAdminClient, type RunTrace } from "@synapse/runtime-client";
import { workspaceSummary } from "../lib/session-presentation.js";

/** 旧 Runtime 缺少列表字段时按会话缓存补读，单批四路读取且不会混入其他会话数据 */
export function useLegacySessionSummaries(
  client: RuntimeAdminClient,
  items: readonly Record<string, unknown>[],
  runs: readonly RunTrace[],
  refresh = 0
) {
  const cache = useRef(new Map<string, { version: string; value: Record<string, unknown> }>());
  const [summaries, setSummaries] = useState<ReadonlyMap<string, Record<string, unknown>>>(new Map());
  const versions = new Map<string, string>();
  for (const run of runs) if (!versions.has(run.sessionId)) versions.set(run.sessionId, run.updatedAt);
  const targets = items
    .filter((item) => !("lastMessageAt" in item))
    .map((item) => ({ id: String(item.id), version: versions.get(String(item.id)) ?? "initial" }));
  const signature = JSON.stringify(targets);
  useEffect(() => {
    let active = true;
    const queue = (JSON.parse(signature) as { id: string; version: string }[]).filter(
      (target) => cache.current.get(target.id)?.version !== target.version
    );
    const read = async (): Promise<void> => {
      if (active && queue.length) {
        const target = queue.shift();
        if (!target) return;
        try {
          const view = await client.workspace(target.id);
          if (active && view.session.id === target.id) {
            const value = workspaceSummary(view);
            cache.current.set(target.id, { version: target.version, value });
            setSummaries((current) => new Map(current).set(target.id, value));
          }
        } catch {
          // 展示补读失败保留列表入口，当前会话主请求仍负责可见错误与重试
        }
        if (active) await read();
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, read));
    return () => {
      active = false;
    };
  }, [client, signature, refresh]);
  return summaries;
}

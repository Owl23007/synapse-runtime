import { useEffect, useRef, useState } from "react";
import { type RuntimeAdminClient, type RunEvent } from "@synapse/runtime-client";
import { mergeEvents, message } from "../../../shared/lib/runtime.js";

/** 选中运行直接消费实时正文，分页补读与流共享去重缓存且不跳过历史游标 */
export function useRunActivity(client: RuntimeAdminClient, runId: string | undefined, revision: number) {
  const cache = useRef<{ id: string; events: RunEvent[]; cursor: number } | undefined>(undefined);
  const [result, setResult] = useState<{ id: string; events: RunEvent[] }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!runId) return;
    let active = true;
    const stop = client.streamRuns({
      onEvent: (event) => {
        if (!active || event.runId !== runId) return;
        const current = cache.current?.id === runId ? cache.current : { id: runId, events: [], cursor: 0 };
        const events = mergeEvents(runId, current.events, [event]);
        // 流收到的序号可能跨过未补读的历史，只推进 SSE 自身游标而不推进 REST 游标
        cache.current = { ...current, events };
        setResult({ id: runId, events });
      },
      onReset: () => {
        if (!active) return;
        cache.current = undefined;
        setPage((value) => value + 1);
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [client, runId]);
  useEffect(() => {
    if (!runId) return;
    let active = true;
    const current = cache.current?.id === runId ? cache.current : { id: runId, events: [], cursor: 0 };
    setError("");
    setLoading(true);
    void client
      .runEvents(runId, current.cursor, 200)
      .then((response) => {
        if (!active) return undefined;
        if (response.hasMore && response.nextSeq <= current.cursor) throw new Error("运行事件游标未推进，请重试");
        const events = mergeEvents(
          runId,
          cache.current?.id === runId ? cache.current.events : current.events,
          response.events
        );
        cache.current = { id: runId, events, cursor: response.nextSeq };
        setResult({ id: runId, events });
        if (response.hasMore) setPage((value) => value + 1);
        return undefined;
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, runId, revision, page]);
  return {
    events: result && result.id === runId ? result.events : [],
    error: runId ? error : "",
    loading,
    reload: () => setPage((value) => value + 1)
  };
}

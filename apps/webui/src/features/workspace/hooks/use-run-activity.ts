import { useEffect, useRef, useState } from "react";
import { type RuntimeAdminClient, type RunEvent } from "@synapse/runtime-client";
import { mergeEvents, message } from "../../../shared/lib/runtime.js";

/** 增量读取选中运行的真实事件，切换会话时拒绝迟到响应并持续补齐分页 */
export function useRunActivity(client: RuntimeAdminClient, runId: string | undefined, revision: number) {
  const cache = useRef<{ id: string; events: RunEvent[]; cursor: number } | undefined>(undefined);
  const [result, setResult] = useState<{ id: string; events: RunEvent[] }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
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
        const events = mergeEvents(runId, current.events, response.events);
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

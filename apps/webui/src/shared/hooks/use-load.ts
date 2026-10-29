import { useEffect, useState } from "react";
import { message } from "../lib/runtime.js";

/** 丢弃页面切换与刷新前的旧响应，保留错误前的可用数据 */
export function useLoad<T>(load: () => Promise<T>, revision = 0) {
  const [result, setResult] = useState<{ source: () => Promise<T>; value: T }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void load()
      .then((value) => {
        if (active) setResult({ source: load, value });
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
  }, [load, revision, nonce]);
  return {
    value: result?.source === load ? result.value : undefined,
    error,
    loading,
    reload: () => setNonce((v) => v + 1)
  };
}

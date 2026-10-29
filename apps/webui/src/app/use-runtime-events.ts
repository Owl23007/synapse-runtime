import { useEffect, useState } from "react";
import { type RunStreamState } from "@synapse/runtime-client";
import { type RuntimeConnection } from "./types.js";

/** 订阅持久运行流并合并刷新，保持离线恢复、游标接续与清理边界 */
export function useRuntimeEvents(connection: RuntimeConnection | undefined) {
  const [stream, setStream] = useState<RunStreamState>("connecting");
  const [revision, setRevision] = useState(0);
  const [lastSync, setLastSync] = useState<string>();
  useEffect(() => {
    if (!connection) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: number | undefined;
    let stop = () => {};
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        setRevision((v) => v + 1);
        setLastSync(new Date().toISOString());
      }, 250);
    };
    const connect = () => {
      if (!navigator.onLine) {
        setStream("reconnecting");
        return;
      }
      stop();
      stop = connection.client.streamRuns({
        ...(cursor === undefined ? {} : { afterCursor: cursor }),
        onEvent: (event) => {
          cursor = event.cursor;
          refresh();
        },
        onSnapshot: (snapshot) => {
          cursor ??= snapshot.cursor;
          refresh();
        },
        onReset: () => {
          cursor = undefined;
          refresh();
        },
        onState: setStream
      });
    };
    const offline = () => {
      stop();
      setStream("reconnecting");
    };
    addEventListener("online", connect);
    addEventListener("offline", offline);
    connect();
    return () => {
      removeEventListener("online", connect);
      removeEventListener("offline", offline);
      stop();
      clearTimeout(timer);
    };
  }, [connection]);
  return { stream, revision, lastSync };
}

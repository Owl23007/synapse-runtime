import { useRef, useState } from "react";
import { type ConnectionDraft, type RuntimeConnection } from "./types.js";
import { toast } from "../shared/lib/toast.js";
import { AppShell } from "./app-shell.js";
import { AppRouter } from "./app-router.js";
import { ConnectionScreen } from "./connection-screen.js";
import { useHashRoute } from "./routes.js";
import { useRuntimeEvents } from "./use-runtime-events.js";

/** 装配连接生命周期，断开保留页面会话，退出与重新认证销毁凭据并停止订阅 */
export function App() {
  const [connection, setConnection] = useState<RuntimeConnection>();
  const draft = useRef<ConnectionDraft | undefined>(undefined);
  const route = useHashRoute();
  const events = useRuntimeEvents(connection);
  const disconnect = (clearCredentials: boolean) => {
    if (clearCredentials && draft.current) draft.current = { endpoint: draft.current.endpoint, token: "" };
    toast.clear();
    setConnection(undefined);
  };
  if (!connection)
    return (
      <ConnectionScreen
        initialConnection={draft.current}
        onConnect={(client, endpoint, token) => {
          draft.current = { endpoint, token };
          setConnection({ client, endpoint });
        }}
      />
    );
  return (
    <AppShell
      route={route}
      stream={events.stream}
      endpoint={connection.endpoint}
      onDisconnect={() => disconnect(false)}
      onLogout={() => disconnect(true)}
    >
      <AppRouter route={route} client={connection.client} revision={events.revision} />
    </AppShell>
  );
}

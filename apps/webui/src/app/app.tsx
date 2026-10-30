import { useRef, useState } from "react";
import { type ConnectionDraft, type RuntimeConnection } from "./types.js";
import { toast } from "../shared/lib/toast.js";
import { AppShell } from "./app-shell.js";
import { AppRouter } from "./app-router.js";
import { ConnectionScreen } from "./connection-screen.js";
import { useHashRoute } from "./routes.js";
import { useRuntimeEvents } from "./use-runtime-events.js";

/** 装配连接与路由，退出仅停止会话订阅，同源凭据留在页面内存中供重新连接 */
export function App() {
  const [connection, setConnection] = useState<RuntimeConnection>();
  const draft = useRef<ConnectionDraft | undefined>(undefined);
  const route = useHashRoute();
  const events = useRuntimeEvents(connection);
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
      onDisconnect={() => {
        toast.clear();
        setConnection(undefined);
      }}
    >
      <AppRouter route={route} client={connection.client} revision={events.revision} />
    </AppShell>
  );
}

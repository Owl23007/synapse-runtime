import { useState } from "react";
import { type RuntimeConnection } from "./types.js";
import { AppShell } from "./app-shell.js";
import { AppRouter } from "./app-router.js";
import { ConnectionScreen } from "./connection-screen.js";
import { useHashRoute } from "./routes.js";
import { useRuntimeEvents } from "./use-runtime-events.js";

/** 应用入口只装配连接、路由与实时刷新，业务状态由各功能模块持有 */
export function App() {
  const [connection, setConnection] = useState<RuntimeConnection>();
  const route = useHashRoute();
  const events = useRuntimeEvents(connection);
  if (!connection) return <ConnectionScreen onConnect={(client, endpoint) => setConnection({ client, endpoint })} />;
  return (
    <AppShell
      connection={connection}
      route={route}
      stream={events.stream}
      lastSync={events.lastSync}
      onDisconnect={() => setConnection(undefined)}
    >
      <AppRouter route={route} client={connection.client} revision={events.revision} />
    </AppShell>
  );
}

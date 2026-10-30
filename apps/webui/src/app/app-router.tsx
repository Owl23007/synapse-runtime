import { lazy, Suspense } from "react";
import { Empty, Loading } from "../shared/ui/feedback.js";
import { type ViewProps } from "../shared/types/runtime.js";
import { type AppRoute } from "./routes.js";
import { PageBoundary } from "./page-boundary.js";

const Workspace = lazy(() =>
  import("../features/workspace/workspace-page.js").then((module) => ({ default: module.Workspace }))
);
const Overview = lazy(() =>
  import("../features/runs/overview-page.js").then((module) => ({ default: module.Overview }))
);
const Runs = lazy(() => import("../features/runs/runs-page.js").then((module) => ({ default: module.Runs })));
const RunDetail = lazy(() =>
  import("../features/runs/run-detail-page.js").then((module) => ({ default: module.RunDetail }))
);
const Explorer = lazy(() =>
  import("../features/explorer/explorer-page.js").then((module) => ({ default: module.Explorer }))
);
const System = lazy(() => import("../features/system/system-page.js").then((module) => ({ default: module.System })));
const Files = lazy(() => import("../features/files/files-page.js").then((module) => ({ default: module.Files })));
const Capabilities = lazy(() =>
  import("../features/capabilities/capabilities-page.js").then((module) => ({ default: module.Capabilities }))
);

/** 页面按功能懒加载，同一工作台的查询参数变化保留会话列表与折叠偏好 */
export function AppRouter({ route, client, revision }: ViewProps & { route: AppRoute }) {
  let page;
  switch (route.section) {
    case "capabilities":
      page = <Capabilities client={client} revision={revision} />;
      break;
    case "files":
      page = (
        <Files
          key={route.key}
          client={client}
          revision={revision}
          initialWorkspace={route.query.get("workspace") ?? ""}
          sessionId={route.query.get("session") ?? ""}
        />
      );
      break;
    case "workspace":
      page = (
        <Workspace
          client={client}
          revision={revision}
          initialSession={route.query.get("session") ?? ""}
          initialLine={route.query.get("line") ?? ""}
        />
      );
      break;
    case "overview":
      page = <Overview client={client} revision={revision} />;
      break;
    case "runs":
      page = route.id ? (
        <RunDetail key={route.id} client={client} revision={revision} id={route.id} />
      ) : (
        <Runs key={route.key} client={client} revision={revision} />
      );
      break;
    case "explorer":
      page = <Explorer key={route.key} client={client} initialSession={route.query.get("session") ?? ""} />;
      break;
    case "system":
    case "channels":
    case "tasks":
      page = <System key={route.section} client={client} view={route.section} />;
      break;
    default:
      page = <Empty title="页面不存在" text="从左侧导航选择一个页面" />;
  }
  return (
    <PageBoundary key={route.section}>
      <Suspense fallback={<Loading />}>{page}</Suspense>
    </PageBoundary>
  );
}

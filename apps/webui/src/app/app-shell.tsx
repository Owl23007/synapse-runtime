import { NAV_ITEMS, PAGE_ITEMS, type AppRoute } from "./routes.js";
import { useState, type ReactNode } from "react";
import { type RunStreamState } from "@synapse/runtime-client";
import { MaterialProvider } from "../shared/ui/surface.js";
import { Icon, SynapseMark } from "../shared/ui/icons.js";
import { ConnectionCard } from "./connection-card.js";

/** 应用壳装配导航与底部连接卡片，认证或协议异常时保留重新连接入口 */
export function AppShell({
  route,
  stream,
  endpoint,
  onDisconnect,
  children
}: {
  route: AppRoute;
  stream: RunStreamState;
  endpoint: string;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const section = route.section;
  return (
    <MaterialProvider>
      <div
        className={`shell ${section === "workspace" ? "shell-workspace" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      >
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("main-content")?.focus();
          }}
        >
          跳到主要内容
        </a>
        <aside className="sidebar" id="app-navigation">
          <div className="sidebar-header">
            <a className="brand" href="#/workspace" aria-label="Synapse 首页">
              <SynapseMark />
              <span className="sidebar-label">Synapse</span>
            </a>
          </div>
          <nav aria-label="主导航">
            <button
              className="sidebar-collapse"
              aria-label={sidebarCollapsed ? "展开导航" : "收起导航"}
              title={sidebarCollapsed ? "展开导航" : "收起导航"}
              aria-expanded={!sidebarCollapsed}
              aria-controls="app-navigation"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Icon name="sidebar" />
            </button>
            {NAV_ITEMS.map(({ section: key, icon, label, path }) => (
              <a
                key={key}
                title={label}
                aria-label={label}
                aria-current={section === key ? "page" : undefined}
                href={`#${path}`}
              >
                <Icon name={icon} />
                <span className="sidebar-label">{label}</span>
              </a>
            ))}
          </nav>
          <div className="sidebar-footer">
            <a
              className="settings-link"
              href="#/system"
              aria-label="系统状态"
              title="系统状态"
              aria-current={section === "system" ? "page" : undefined}
            >
              <Icon name="settings" />
              <span className="sidebar-label">设置</span>
            </a>
            <ConnectionCard endpoint={endpoint} stream={stream} onDisconnect={onDisconnect} />
          </div>
        </aside>
        <div className="main-shell">
          {section !== "workspace" && (
            <header className="topbar">
              <span>
                工作空间 <span className="separator">/</span>
                {PAGE_ITEMS.find((item) => item.section === section)?.label ??
                  (section === "system" ? "系统状态" : "页面")}
              </span>
            </header>
          )}
          {(stream === "unauthorized" || stream === "incompatible") && (
            <div className="notice error" role="alert">
              {stream === "unauthorized"
                ? "认证失败，请重新连接并输入凭据"
                : "服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本"}
              <button type="button" onClick={onDisconnect}>
                重新连接
              </button>
            </div>
          )}
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </MaterialProvider>
  );
}

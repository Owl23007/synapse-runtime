import { NAV_ITEMS, type AppRoute } from "./routes.js";
import { useState, type ReactNode } from "react";
import { type RunStreamState } from "@synapse/runtime-client";
import { time } from "../shared/lib/runtime.js";
import { MaterialProvider, MaterialSettings } from "../shared/ui/surface.js";
import { Icon, SynapseMark } from "../shared/ui/icons.js";
import { type RuntimeConnection } from "./types.js";

/** 应用壳只负责导航与连接状态，业务页面通过内容槽挂载 */
export function AppShell({
  connection,
  route,
  stream,
  lastSync,
  onDisconnect,
  children
}: {
  connection: RuntimeConnection;
  route: AppRoute;
  stream: RunStreamState;
  lastSync: string | undefined;
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
        <aside className="sidebar">
          <div className="sidebar-header">
            <a className="brand" href="#/">
              <SynapseMark />
              <span className="sidebar-label">Synapse</span>
            </a>
            <button
              className="icon-button sidebar-collapse"
              aria-label={sidebarCollapsed ? "展开导航" : "收起导航"}
              title={sidebarCollapsed ? "展开导航" : "收起导航"}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Icon name="chevron" style={{ transform: sidebarCollapsed ? undefined : "rotate(180deg)" }} />
            </button>
          </div>
          <nav aria-label="主导航">
            {NAV_ITEMS.map(({ section: key, icon, label, path }) => (
              <a
                key={key}
                title={label}
                aria-label={label}
                aria-current={section === key ? "page" : undefined}
                href={`#${path}`}
              >
                <Icon name={icon} />
                <span className="sidebar-label">{key === "workspace" ? "工作空间" : label}</span>
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
            <div className="sidebar-runtime">
              <span role="status" className={`connection ${stream === "connected" ? "online" : ""}`}>
                {stream !== "connected" && lastSync && <small>更新于 {time(lastSync)}</small>}
                <span className="dot" />
                <span>
                  {
                    {
                      connecting: "连接中",
                      connected: "实时连接",
                      reconnecting: "正在重连",
                      unauthorized: "认证已失效",
                      incompatible: "版本不兼容",
                      stopped: "已断开"
                    }[stream]
                  }
                </span>
              </span>
              <small className="sidebar-label" title={connection.endpoint}>
                {new URL(connection.endpoint).host}
              </small>
              <div className="sidebar-utilities">
                <MaterialSettings />
                <button className="icon-button" aria-label="断开连接" title="断开连接" onClick={onDisconnect}>
                  <Icon name="run" />
                </button>
              </div>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          {section !== "workspace" && (
            <header className="topbar">
              <span>
                工作空间 <span className="separator">/</span>
                {NAV_ITEMS.find((item) => item.section === section)?.label ??
                  (section === "system" ? "系统状态" : "页面")}
              </span>
            </header>
          )}
          {(stream === "unauthorized" || stream === "incompatible") && (
            <div className="notice error" role="alert">
              {stream === "unauthorized"
                ? "认证失败，请断开连接后重新输入凭据"
                : "服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本"}
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

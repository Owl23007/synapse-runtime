import { NAV_ITEMS, PAGE_ITEMS, type AppRoute } from "./routes.js";
import { useId, useRef, useState, type ReactNode } from "react";
import { type RunStreamState } from "@synapse/runtime-client";
import { MaterialProvider } from "../shared/ui/surface.js";
import { Icon, SynapseMark } from "../shared/ui/icons.js";
import { ConnectionCard } from "./connection-card.js";

// 仅记住退出偏好，不持久化令牌；存储不可用时仍在当前页面保留选择
const CLEAR_TOKEN_ON_EXIT_KEY = "synapse.runtime.clear-token-on-exit.v1";
let clearTokenPreference = false;

function readClearTokenPreference(): boolean {
  try {
    clearTokenPreference = localStorage.getItem(CLEAR_TOKEN_ON_EXIT_KEY) === "true";
  } catch {
    // 浏览器禁用存储时沿用页面内存偏好，不能阻止退出
  }
  return clearTokenPreference;
}

/** 应用壳统一导航与退出入口，文件页直接展示资源工具栏；退出时可保留或清除页面内存凭据 */
export function AppShell({
  route,
  stream,
  endpoint,
  onDisconnect,
  onLogout,
  children
}: {
  route: AppRoute;
  stream: RunStreamState;
  endpoint: string;
  onDisconnect: () => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [clearTokenOnExit, setClearTokenOnExit] = useState(readClearTokenPreference);
  const exitDialog = useRef<HTMLDialogElement>(null);
  const exitTitle = useId();
  const exitDescription = useId();
  const section = route.section;
  return (
    <MaterialProvider>
      <div
        className={`shell ${section === "workspace" ? "shell-workspace" : ""} ${section === "files" ? "shell-files" : ""} ${section === "runs" && !route.id ? "shell-runs" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
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
            <ConnectionCard endpoint={endpoint} stream={stream} onDisconnect={() => exitDialog.current?.showModal()} />
          </div>
        </aside>
        <div className="main-shell">
          {section !== "workspace" && section !== "files" && !(section === "runs" && !route.id) && (
            <header className="topbar">
              <span>
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
              <button type="button" onClick={onLogout}>
                重新认证
              </button>
            </div>
          )}
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <dialog
        ref={exitDialog}
        className="connection-exit-dialog"
        aria-labelledby={exitTitle}
        aria-describedby={exitDescription}
      >
        <h2 id={exitTitle}>退出连接</h2>
        <p id={exitDescription}>退出后保留当前页面的令牌，方便重新连接；勾选“同时清空令牌”后，重连需要重新输入</p>
        <label className="connection-exit-option">
          <input
            type="checkbox"
            checked={clearTokenOnExit}
            onChange={(event) => {
              const checked = event.target.checked;
              setClearTokenOnExit(checked);
              clearTokenPreference = checked;
              try {
                localStorage.setItem(CLEAR_TOKEN_ON_EXIT_KEY, String(checked));
              } catch {
                // 偏好保存失败时仍按本次选择退出
              }
            }}
          />
          同时清空令牌
        </label>
        <div className="connection-exit-actions">
          <button type="button" autoFocus onClick={() => exitDialog.current?.close()}>
            取消
          </button>
          <button type="button" className="primary" onClick={clearTokenOnExit ? onLogout : onDisconnect}>
            直接退出
          </button>
        </div>
      </dialog>
    </MaterialProvider>
  );
}

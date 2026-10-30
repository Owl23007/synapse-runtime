import { useId, useRef, useState, type FormEvent } from "react";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { normalizeEndpoint, record, message } from "../shared/lib/runtime.js";
import { ErrorNotice } from "../shared/ui/feedback.js";
import { Icon, SynapseMark } from "../shared/ui/icons.js";
import { ConnectionManager } from "./connection-manager.js";
import { type ConnectionDraft } from "./types.js";
import {
  createSavedConnection,
  isLocalEndpoint,
  readSavedConnections,
  upsertSavedConnection,
  writeSavedConnections,
  type SavedConnection
} from "./saved-connections.js";

const STORAGE_WARNING = "浏览器存储不可用，连接记录仅在当前页面有效";

function initialConnections() {
  try {
    return { connections: readSavedConnections(window.localStorage), warning: "" };
  } catch {
    return { connections: [], warning: STORAGE_WARNING };
  }
}

function normalizedEndpoint(input: string): string | undefined {
  try {
    return normalizeEndpoint(input);
  } catch {
    return undefined;
  }
}

function ConnectionActions({
  connection,
  disabled,
  onEdit,
  onDelete
}: {
  connection: SavedConnection;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const positionMenu = () => {
    // 以卡片边缘定位，菜单与卡片右侧对齐并在上下方向留出间距
    const rect = trigger.current!.closest("li")!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.right - 144, innerWidth - 152)),
      top: rect.bottom + 98 > innerHeight ? Math.max(8, rect.top - 90) : rect.bottom + 8
    });
  };
  const run = (action: () => void) => {
    menu.current?.hidePopover();
    // 弹窗需记住卡片上的入口，避免关闭时试图聚焦已经隐藏的菜单项
    trigger.current?.focus();
    action();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="connection-icon-button"
        disabled={disabled}
        aria-label={`管理 ${connection.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        popoverTarget={id}
        onClick={positionMenu}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          positionMenu();
          menu.current?.showPopover();
          const items = menu.current?.querySelectorAll<HTMLButtonElement>("button");
          (event.key === "ArrowUp" ? items?.[1] : items?.[0])?.focus();
        }}
      >
        <Icon name="more" />
      </button>
      <div
        ref={menu}
        id={id}
        role="menu"
        aria-label={`${connection.name} 的操作`}
        popover="auto"
        className="connection-actions-menu"
        style={{ inset: "auto", ...position }}
        onToggle={(event) => {
          const element = event.currentTarget;
          const visible = element.matches(":popover-open");
          setOpen(visible);
          if (visible && !element.contains(document.activeElement)) element.querySelector("button")?.focus();
        }}
        onBlur={(event) => {
          if (event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget))
            event.currentTarget.hidePopover();
        }}
        onKeyDown={(event) => {
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = {
            ArrowDown: (index + 1) % items.length,
            ArrowUp: (index + items.length - 1) % items.length,
            Home: 0,
            End: items.length - 1
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        <button type="button" role="menuitem" disabled={disabled} onClick={() => run(onEdit)}>
          修改
        </button>
        <button
          type="button"
          role="menuitem"
          className="connection-delete"
          disabled={disabled}
          onClick={() => run(onDelete)}
        >
          删除
        </button>
      </div>
    </>
  );
}

/** 提供同源连接入口，退出后从页面内存回填凭据，服务书签仍不包含令牌 */
export function ConnectionScreen({
  onConnect,
  initialConnection
}: {
  onConnect: (client: RuntimeAdminClient, endpoint: string, token: string) => void;
  initialConnection?: ConnectionDraft | undefined;
}) {
  const [initial] = useState(initialConnections);
  const [connections, setConnections] = useState(initial.connections);
  const [storageWarning, setStorageWarning] = useState(initial.warning);
  const [endpoint, setEndpoint] = useState(initialConnection?.endpoint ?? location.origin);
  const [token, setToken] = useState(initialConnection?.endpoint === location.origin ? initialConnection.token : "");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manager, setManager] = useState<{ selected?: SavedConnection }>();
  const tokenInput = useRef<HTMLInputElement>(null);
  const endpointInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const normalized = normalizedEndpoint(endpoint);
  const external = normalized !== undefined && normalized !== location.origin;
  const updateConnections = (next: SavedConnection[]) => {
    setConnections(next);
    try {
      writeSavedConnections(window.localStorage, next);
      setStorageWarning("");
    } catch {
      setStorageWarning(STORAGE_WARNING);
    }
  };
  const select = (connection: SavedConnection) => {
    setEndpoint(connection.endpoint);
    setToken("");
    setShowToken(false);
    setError("");
    if (connection.endpoint === location.origin) tokenInput.current?.focus();
    else endpointInput.current?.focus();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    submitting.current = true;
    setBusy(true);
    try {
      const target = normalizeEndpoint(endpoint);
      const previous = connections.find((item) => item.endpoint === target);
      if (target !== location.origin) {
        // 不跨源发送认证请求，也不通过 URL、存储或窗口通信传递令牌
        setToken("");
        setShowToken(false);
        updateConnections(upsertSavedConnection(connections, previous ?? createSavedConnection(target)));
        window.location.assign(`${target}/`);
        return;
      }
      if (token && new URL(target).protocol !== "https:" && !isLocalEndpoint(target)) {
        throw new Error("请通过 HTTPS 打开此 Runtime 后再使用访问令牌，避免令牌通过明文网络传输");
      }
      const client = new RuntimeAdminClient({ endpoint: target, ...(token ? { token } : {}) });
      const status = record(await client.status());
      if (status.protocolVersion !== 1) throw new Error("服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本");
      updateConnections(upsertSavedConnection(connections, createSavedConnection(target, previous?.name, Date.now())));
      setToken("");
      setShowToken(false);
      onConnect(client, target, token);
    } catch (cause) {
      setError(message(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="connect-page">
      <div className="connect-form">
        <header className="connect-heading">
          <a href="#/" className="connect-brand" aria-label="Synapse 首页">
            <span className="connect-brand-icon">
              <SynapseMark />
            </span>
            <span>Synapse</span>
          </a>
          <h1>连接 Runtime</h1>
          <p>连接服务，进入你的工作空间</p>
        </header>
        <form onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy}>
            <label htmlFor="runtime-endpoint">服务地址</label>
            <div className="connection-input">
              <Icon name="link" />
              <input
                ref={endpointInput}
                id="runtime-endpoint"
                required
                type="url"
                maxLength={2048}
                value={endpoint}
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  setToken("");
                  setShowToken(false);
                  setError("");
                }}
                autoComplete="url"
                spellCheck={false}
              />
            </div>
            <label htmlFor="runtime-token">
              访问令牌 <span className="muted">可选</span>
            </label>
            <div className="connection-input">
              <Icon name="lock" />
              <input
                ref={tokenInput}
                id="runtime-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="输入 Admin Token"
                aria-describedby="connection-security"
                disabled={external}
              />
              <button
                type="button"
                className="connection-icon-button"
                aria-label={showToken ? "隐藏令牌" : "显示令牌"}
                aria-pressed={showToken}
                disabled={external}
                onClick={() => setShowToken(!showToken)}
              >
                <Icon name={showToken ? "eyeOff" : "eye"} />
              </button>
            </div>
            {external && (
              <p className="connection-remote-hint" role="status">
                将在目标服务页面连接，请在那里输入访问令牌
              </p>
            )}
            <ErrorNotice error={error} />
            <button type="submit" className="primary full connect-submit" disabled={busy}>
              {busy ? "正在连接…" : external ? "打开 Runtime" : "连接 Runtime"}
              <Icon name="arrowRight" />
            </button>
          </fieldset>
        </form>
        <section className="recent-connections" aria-labelledby="recent-connections-title">
          <div className="recent-connections-heading">
            <h2 id="recent-connections-title">最近连接</h2>
          </div>
          <ul className="recent-connections-list">
            {connections.slice(0, 5).map((connection) => (
              <li key={connection.endpoint}>
                <button
                  type="button"
                  className="saved-connection"
                  disabled={busy}
                  aria-label={`选择 ${connection.name}`}
                  onClick={() => select(connection)}
                >
                  <span
                    className={`connection-service-icon ${isLocalEndpoint(connection.endpoint) ? "local" : "remote"}`}
                  >
                    <Icon name={isLocalEndpoint(connection.endpoint) ? "monitor" : "server"} />
                  </span>
                  <span className="connection-copy">
                    <strong>{connection.name}</strong>
                    <span>{new URL(connection.endpoint).host}</span>
                  </span>
                  <Icon name="chevron" />
                </button>
                <ConnectionActions
                  connection={connection}
                  disabled={busy}
                  onEdit={() => setManager({ selected: connection })}
                  onDelete={() =>
                    updateConnections(connections.filter((item) => item.endpoint !== connection.endpoint))
                  }
                />
              </li>
            ))}
          </ul>
          {!connections.length && (
            <p className="recent-connections-empty">暂无连接记录，成功连接后会自动保存服务地址</p>
          )}
          {storageWarning && (
            <p className="connection-storage-warning" role="status">
              {storageWarning}
            </p>
          )}
        </section>
      </div>
      <p id="connection-security" className="connection-security">
        <Icon name="lock" />
        <span>仅保存名称和地址，退出保留页面内存中的令牌，刷新后清除</span>
      </p>
      {manager && (
        <ConnectionManager
          connections={connections}
          selected={manager.selected}
          warning={storageWarning}
          onChange={updateConnections}
          onClose={() => setManager(undefined)}
        />
      )}
    </div>
  );
}

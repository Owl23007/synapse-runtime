import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../shared/ui/icons.js";
import { message } from "../shared/lib/runtime.js";
import { ErrorNotice } from "../shared/ui/feedback.js";
import { createSavedConnection, upsertSavedConnection, type SavedConnection } from "./saved-connections.js";

/** 复用书签管理与精简编辑弹窗，快捷编辑完成后关闭并恢复触发控件焦点 */
export function ConnectionManager({
  connections,
  selected,
  warning,
  onChange,
  onClose
}: {
  connections: readonly SavedConnection[];
  selected: SavedConnection | undefined;
  warning: string;
  onChange: (connections: SavedConnection[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(!!selected);
  const [original, setOriginal] = useState(selected?.endpoint);
  const [name, setName] = useState(selected?.name ?? "");
  const [endpoint, setEndpoint] = useState(selected?.endpoint ?? "");
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      element?.close();
      // React 卸载模态窗口时浏览器未必能恢复原焦点，显式返回触发控件
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    // 原生对话框打开前无法聚焦输入框，在进入编辑状态后显式定位
    if (editing) nameInput.current?.focus();
  }, [editing]);
  const edit = (connection?: SavedConnection) => {
    setOriginal(connection?.endpoint);
    setName(connection?.name ?? "");
    setEndpoint(connection?.endpoint ?? "");
    setError("");
    setConfirmClear(false);
    setEditing(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    try {
      const previous = connections.find((item) => item.endpoint === original);
      const normalized = createSavedConnection(endpoint, name);
      const connection = createSavedConnection(
        normalized.endpoint,
        normalized.name,
        previous?.endpoint === normalized.endpoint ? previous.lastConnectedAt : null
      );
      if (connections.some((item) => item.endpoint === connection.endpoint && item.endpoint !== original))
        throw new Error("该服务地址已保存，请编辑已有连接");
      if (!original && connections.length >= 20) throw new Error("最多保存 20 个连接，请先删除不再使用的连接");
      onChange(
        upsertSavedConnection(
          connections.filter((item) => item.endpoint !== original),
          connection
        )
      );
      if (selected) onClose();
      else setEditing(false);
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <dialog
      ref={dialog}
      className="connection-manager"
      aria-labelledby="connection-manager-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="connection-manager-heading">
        <h2 id="connection-manager-title">{editing ? (original ? "编辑连接" : "新增连接") : "管理连接"}</h2>
        <button type="button" className="connection-icon-button" aria-label="关闭管理连接" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {warning && (
        <p className="connection-storage-warning" role="status">
          {warning}
        </p>
      )}
      {editing ? (
        <form className="connection-editor" onSubmit={save}>
          <label>
            连接名称
            <input
              ref={nameInput}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：开发环境"
            />
          </label>
          <label>
            服务地址
            <input
              required
              type="url"
              maxLength={2048}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://runtime.example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <ErrorNotice error={error} />
          <div className="connection-editor-actions">
            <button type="button" onClick={() => (selected ? onClose() : setEditing(false))}>
              取消
            </button>
            <button type="submit" className="primary">
              保存连接
            </button>
          </div>
        </form>
      ) : (
        <>
          <ul className="connection-manager-list">
            {connections.map((connection) => (
              <li key={connection.endpoint}>
                <div className="connection-copy">
                  <strong>{connection.name}</strong>
                  <span>{connection.endpoint}</span>
                </div>
                <button type="button" aria-label={`编辑 ${connection.name}`} onClick={() => edit(connection)}>
                  编辑
                </button>
                <button
                  type="button"
                  className="connection-delete"
                  aria-label={`删除 ${connection.name}`}
                  onClick={() => {
                    onChange(connections.filter((item) => item.endpoint !== connection.endpoint));
                    setConfirmClear(false);
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
          {!connections.length && <p className="connection-manager-empty">暂无保存的连接，添加常用服务以便下次访问</p>}
          <div className="connection-manager-actions">
            <button type="button" className="primary" onClick={() => edit()}>
              <Icon name="plus" />
              新增连接
            </button>
            {connections.length > 0 && (
              <button type="button" className="text-button connection-delete" onClick={() => setConfirmClear(true)}>
                清空连接
              </button>
            )}
          </div>
          {confirmClear && (
            <div className="connection-clear-confirm" role="group" aria-label="确认清空连接">
              <span>清空此浏览器保存的全部连接？</span>
              <button type="button" onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button
                type="button"
                className="connection-delete"
                onClick={() => {
                  onChange([]);
                  setConfirmClear(false);
                }}
              >
                确认清空
              </button>
            </div>
          )}
        </>
      )}
    </dialog>
  );
}

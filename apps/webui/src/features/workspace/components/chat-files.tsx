import { useCallback, useId, useRef, useState } from "react";
import type { RuntimeAdminClient, AssetAttachmentInfo, AssetInfo } from "@synapse/runtime-client";
import { useLoad } from "../../../shared/hooks/use-load.js";
import { ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { message } from "../../../shared/lib/runtime.js";
import { Icon } from "../../../shared/ui/icons.js";
import "../../files/files.css";

/** 附件标签独立置于正文上方，长文件名截断但保留完整名称 */
export function ChatAttachments({
  attachments,
  onChange,
  disabled
}: {
  attachments: readonly AssetAttachmentInfo[];
  onChange: (value: readonly AssetAttachmentInfo[]) => void;
  disabled: boolean;
}) {
  if (!attachments.length) return null;
  return (
    <ul className="composer-attachments" aria-label="待发送附件">
      {attachments.map((item) => (
        <li key={item.assetId}>
          <Icon name={/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(item.name) ? "image" : "file"} />
          <span title={item.name}>{item.name}</span>
          <button
            type="button"
            className="icon-button"
            aria-label={`移除附件 ${item.name}`}
            disabled={disabled}
            onClick={() => onChange(attachments.filter((attachment) => attachment.assetId !== item.assetId))}
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 加号菜单统一提供上传与已有文件选择，使用顶层弹出层避免撑高输入区 */
export function ChatFiles({
  client,
  sessionId,
  attachments,
  onChange,
  onBusyChange,
  disabled
}: {
  client: RuntimeAdminClient;
  sessionId: string;
  attachments: readonly AssetAttachmentInfo[];
  onChange: (value: readonly AssetAttachmentInfo[]) => void;
  onBusyChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const pickerId = useId();
  const [position, setPosition] = useState({ left: 16, bottom: 64 });
  const fileInput = useRef<HTMLInputElement>(null);
  const keys = useRef(new WeakMap<File, string>());
  const workspace = useLoad(
    useCallback(() => client.sessionResourceWorkspace(sessionId), [client, sessionId]),
    0
  );
  const workspaceId = workspace.value?.workspaceId;
  const files = useLoad(
    useCallback(
      () => (open && workspaceId ? client.assets(workspaceId, { q }) : Promise.resolve(undefined)),
      [client, open, workspaceId, q]
    ),
    nonce
  );
  const add = async (asset: AssetInfo) => {
    if (disabled || busy || attachments.length >= 20 || attachments.some((item) => item.assetId === asset.id)) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const versionId = asset.currentVersionId ?? (await client.materializeAsset(asset.id)).version.id;
      onChange([...attachments, { assetId: asset.id, versionId, name: asset.displayName }]);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  const upload = async (file: File) => {
    if (!workspaceId || disabled || busy || attachments.length >= 20) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    let key = keys.current.get(file);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(file, key);
    }
    try {
      const result = await client.uploadAsset(workspaceId, file, key);
      onChange([
        ...attachments,
        { assetId: result.asset.id, versionId: result.version.id, name: result.asset.displayName }
      ]);
      setNonce((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="icon-button composer-add"
        aria-label="添加附件"
        title={busy ? "正在附加文件…" : "添加附件"}
        aria-expanded={open}
        aria-controls={pickerId}
        popoverTarget={pickerId}
        disabled={disabled || busy || attachments.length >= 20}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)),
            bottom: window.innerHeight - rect.top + 8
          });
        }}
      >
        <Icon name="plus" />
      </button>
      <input
        ref={fileInput}
        hidden
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
      />
      <section
        id={pickerId}
        popover="auto"
        className="composer-file-picker"
        aria-label="选择工作区附件"
        style={position}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <div className="composer-file-actions">
          <button
            type="button"
            disabled={disabled || busy || !workspaceId || attachments.length >= 20}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="plus" />
            {busy ? "正在附加…" : "上传并附加"}
          </button>
          <a href={`#/files?session=${encodeURIComponent(sessionId)}`}>管理文件</a>
        </div>
        <ErrorNotice error={error || workspace.error || files.error} />
        {(workspace.error || files.error) && (
          <button
            type="button"
            onClick={() => {
              workspace.reload();
              setNonce((value) => value + 1);
            }}
          >
            重新加载文件
          </button>
        )}
        {open && (
          <>
            <input
              aria-label="搜索待附加文件"
              placeholder="搜索已有文件"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            {files.loading || workspace.loading ? (
              <Loading />
            ) : !files.error && !workspace.error && !files.value?.items.length ? (
              <p className="composer-files-empty">{q ? "没有匹配的文件" : "暂无文件，可上传后附加"}</p>
            ) : (
              files.value?.items.map((asset) => (
                <button
                  className="file-row"
                  type="button"
                  key={asset.id}
                  disabled={
                    disabled ||
                    busy ||
                    attachments.some((item) => item.assetId === asset.id) ||
                    attachments.length >= 20
                  }
                  onClick={() => void add(asset)}
                >
                  <span>
                    <strong>{asset.displayName}</strong>
                    <small>{asset.currentVersionId ? "使用当前内容版本" : "获取远端文件并固定版本"}</small>
                  </span>
                  <span>{attachments.some((item) => item.assetId === asset.id) ? "已附加" : "附加"}</span>
                </button>
              ))
            )}
          </>
        )}
      </section>
    </>
  );
}

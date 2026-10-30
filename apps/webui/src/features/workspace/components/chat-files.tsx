import { useCallback, useRef, useState } from "react";
import type { RuntimeAdminClient, AssetAttachmentInfo, AssetInfo } from "@synapse/runtime-client";
import { useLoad } from "../../../shared/hooks/use-load.js";
import { ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { message } from "../../../shared/lib/runtime.js";
import "../../files/files.css";

/** 会话只选择关联附件，完整文件管理通过独立 Files 入口完成 */
export function ChatFiles({
  client,
  sessionId,
  attachments,
  onChange,
  disabled
}: {
  client: RuntimeAdminClient;
  sessionId: string;
  attachments: readonly AssetAttachmentInfo[];
  onChange: (value: readonly AssetAttachmentInfo[]) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
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
    if (attachments.some((item) => item.assetId === asset.id)) return;
    setBusy(true);
    setError("");
    try {
      const versionId = asset.currentVersionId ?? (await client.materializeAsset(asset.id)).version.id;
      onChange([...attachments, { assetId: asset.id, versionId, name: asset.displayName }]);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File) => {
    if (!workspaceId) return;
    setBusy(true);
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
    }
  };
  return (
    <>
      <div className="attachment-chips">
        {attachments.map((item) => (
          <span key={item.assetId}>
            {item.name}
            <button
              type="button"
              aria-label={`移除附件 ${item.name}`}
              disabled={disabled || busy}
              onClick={() => onChange(attachments.filter((attachment) => attachment.assetId !== item.assetId))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="resource-toolbar chat-files">
        <button type="button" disabled={disabled || busy || attachments.length >= 20} onClick={() => setOpen(!open)}>
          {open ? "收起文件选择" : "添加附件"}
        </button>
        <button
          type="button"
          disabled={disabled || busy || !workspaceId || attachments.length >= 20}
          onClick={() => fileInput.current?.click()}
        >
          上传并附加
        </button>
        <a href={`#/files?session=${encodeURIComponent(sessionId)}`}>管理 Files</a>
      </div>
      <input
        ref={fileInput}
        hidden
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <ErrorNotice
        error={error || (open ? workspace.error || files.error : "")}
        retry={() => setNonce((value) => value + 1)}
      />
      {open && (
        <section className="chat-files" aria-label="选择工作区附件">
          <input
            aria-label="搜索待附加文件"
            placeholder="搜索已有文件"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          {files.loading ? (
            <Loading />
          ) : (
            files.value?.items.map((asset) => (
              <button
                className="file-row"
                type="button"
                key={asset.id}
                disabled={
                  disabled || busy || attachments.some((item) => item.assetId === asset.id) || attachments.length >= 20
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
        </section>
      )}
    </>
  );
}

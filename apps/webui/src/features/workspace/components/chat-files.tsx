import { useCallback, useId, useRef, useState } from "react";
import type { RuntimeAdminClient, AssetAttachmentInfo, AssetInfo } from "@synapse/runtime-client";
import { useLoad } from "../../../shared/hooks/use-load.js";
import { ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { message } from "../../../shared/lib/runtime.js";
import { Icon } from "../../../shared/ui/icons.js";
import { toast } from "../../../shared/lib/toast.js";
import { attachWorkspaceFile } from "../lib/attach-file.js";
import { WorkspaceFilePicker } from "./workspace-file-picker.js";

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

/** 加号入口区分本地上传与工作区文件，跨工作区选择明确执行复制并附加 */
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
  const [view, setView] = useState("sources");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const pickerId = useId();
  const [position, setPosition] = useState({ left: 16, bottom: 64 });
  const fileInput = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLElement>(null);
  const keys = useRef(new WeakMap<File, string>());
  const copyKeys = useRef(new Map<string, string>());
  const copied = useRef(new Map<string, string>());
  const pending = useRef(false);
  const workspace = useLoad(
    useCallback(() => client.sessionResourceWorkspace(sessionId), [client, sessionId]),
    0
  );
  const workspaceId = workspace.value?.workspaceId;
  const full = attachments.length >= 20;
  const isSelected = (asset: AssetInfo) =>
    attachments.some((item) => item.assetId === asset.id || item.assetId === copied.current.get(asset.id));
  const act = async (label: string, operation: () => Promise<void>) => {
    if (disabled || pending.current || full || !workspaceId) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setProgress(label);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(message(cause));
      if (picker.current && !picker.current.matches(":popover-open")) picker.current.showPopover();
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  };
  const add = async (asset: AssetInfo) => {
    if (isSelected(asset)) return;
    const copying = asset.workspaceId !== workspaceId;
    await act(`${copying ? "正在复制" : "正在附加"} ${asset.displayName}`, async () => {
      const identity = `${asset.id}:${asset.currentVersionId ?? "remote"}`;
      let key = copyKeys.current.get(identity);
      if (!key) {
        key = crypto.randomUUID();
        copyKeys.current.set(identity, key);
      }
      const attachment = await attachWorkspaceFile(client, workspaceId!, asset, key);
      copied.current.set(asset.id, attachment.assetId);
      onChange([...attachments, attachment]);
      toast.success(copying ? "文件已复制到当前工作区并附加" : "文件已附加");
    });
  };
  const upload = async (files: readonly File[]) => {
    if (!files.length) return;
    const available = 20 - attachments.length;
    if (files.length > available) {
      setError(`最多可附加 20 个文件，还可选择 ${available} 个`);
      return;
    }
    await act("正在上传文件…", async () => {
      const next = [...attachments];
      for (const [index, file] of files.entries()) {
        setProgress(`正在上传 ${index + 1}/${files.length}：${file.name}`);
        let key = keys.current.get(file);
        if (!key) {
          key = crypto.randomUUID();
          keys.current.set(file, key);
        }
        // eslint-disable-next-line no-await-in-loop -- 顺序上传保留成功附件，并在首个失败后停止后续请求
        const result = await client.uploadAsset(workspaceId!, file, key).catch((cause) => {
          throw new Error(`${file.name} 上传失败，已成功的附件会保留：${message(cause)}`);
        });
        next.push({ assetId: result.asset.id, versionId: result.version.id, name: result.asset.displayName });
        onChange([...next]);
      }
      picker.current?.hidePopover();
      toast.success(`已上传并附加 ${files.length} 个文件`);
    });
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
        disabled={disabled || busy || full}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 412)),
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
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          void upload(files);
          event.target.value = "";
        }}
      />
      <section
        ref={picker}
        id={pickerId}
        popover="auto"
        className="composer-file-picker"
        aria-label="添加消息附件"
        style={position}
        onToggle={(event) => {
          const opened = event.newState === "open";
          setOpen(opened);
          if (!opened) setView("sources");
        }}
      >
        <div className="composer-file-heading">
          {view === "files" && (
            <button
              type="button"
              className="icon-button"
              aria-label="返回附件来源"
              disabled={busy}
              onClick={() => setView("sources")}
            >
              <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
            </button>
          )}
          <strong>{view === "files" ? "工作区文件" : "添加附件"}</strong>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭附件选择"
            onClick={() => picker.current?.hidePopover()}
          >
            <Icon name="close" />
          </button>
        </div>
        <ErrorNotice error={error} />
        <ErrorNotice error={workspace.error} retry={workspace.reload} />
        {busy && (
          <p className="composer-file-progress" role="status">
            {progress}
          </p>
        )}
        {open &&
          (workspace.loading ? (
            <Loading />
          ) : view === "files" && workspaceId ? (
            <WorkspaceFilePicker
              client={client}
              workspaceId={workspaceId}
              disabled={disabled || busy || full}
              isSelected={isSelected}
              onAdd={(asset) => void add(asset)}
            />
          ) : (
            <div className="composer-file-sources">
              <button
                type="button"
                disabled={disabled || busy || !workspaceId || full}
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="upload" />
                <span>
                  <strong>本地上传</strong>
                  <small>上传到当前工作区并附加到消息</small>
                </span>
                <Icon name="chevron" />
              </button>
              <button
                type="button"
                disabled={disabled || busy || !workspaceId || full}
                onClick={() => setView("files")}
              >
                <Icon name="folder" />
                <span>
                  <strong>工作区文件</strong>
                  <small>选择当前或其他工作区的已有文件</small>
                </span>
                <Icon name="chevron" />
              </button>
            </div>
          ))}
        <div className="composer-file-footer">
          <a href={`#/files?session=${encodeURIComponent(sessionId)}`}>管理文件</a>
          <span>{attachments.length}/20 已附加</span>
          <button type="button" onClick={() => picker.current?.hidePopover()}>
            完成
          </button>
        </div>
      </section>
    </>
  );
}

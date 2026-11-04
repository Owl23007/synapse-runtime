import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetInfo, AssetVersionInfo, RuntimeAdminClient } from "@synapse/runtime-client";
import type { ViewProps } from "../../shared/types/runtime.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { PageTitle } from "../../shared/ui/content.js";
import { Icon } from "../../shared/ui/icons.js";
import { Empty, ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { message, time } from "../../shared/lib/runtime.js";
import { toast } from "../../shared/lib/toast.js";
import "./files.css";

const sources = [
  ["", "全部"],
  ["qq_group", "QQ 群附件"],
  ["qq_private", "QQ 私聊附件"],
  ["native", "上传文件"],
  ["artifact", "生成工件"],
  ["mount", "挂载文件"]
] as const;
const states: Record<string, string> = {
  "remote-only": "仅远端",
  cached: "已缓存",
  "fetch-failed": "获取失败",
  "remote-unavailable": "远端不可用",
  deleted: "已移除"
};

/** 工作区文件列表保持独立滚动，按需打开检查器与加载预览内容 */
export function Files({
  client,
  revision,
  initialWorkspace = "",
  sessionId = ""
}: ViewProps & { initialWorkspace?: string; sessionId?: string }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [older, setOlder] = useState<readonly AssetInfo[]>([]);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncOpen, setSyncOpen] = useState(false);
  const [channel, setChannel] = useState("");
  const [group, setGroup] = useState("");
  const [folder, setFolder] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLElement>(null);
  const more = useRef<HTMLDetailsElement>(null);
  const closeInspector = useCallback(() => {
    const row = list.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]");
    setSelected("");
    requestAnimationFrame(() => row?.focus({ preventScroll: true }));
  }, []);
  const uploadKeys = useRef(new WeakMap<File, string>());
  const workspaces = useLoad(
    useCallback(() => client.resourceWorkspaces(), [client]),
    revision + nonce
  );
  const session = useLoad(
    useCallback(
      () => (sessionId ? client.sessionResourceWorkspace(sessionId) : Promise.resolve(undefined)),
      [client, sessionId]
    ),
    revision
  );
  const workspaceId = workspace || session.value?.workspaceId || workspaces.value?.items[0]?.id || "";
  const files = useLoad(
    useCallback(
      () =>
        workspaceId
          ? client.assets(workspaceId, { q, ...(source ? { source } : {}), ...(cursor ? { cursor } : {}) })
          : Promise.resolve({ items: [] } as { items: readonly AssetInfo[]; nextCursor?: string }),
      [client, workspaceId, q, source, cursor]
    ),
    revision + nonce
  );
  useEffect(() => {
    setCursor(undefined);
    setOlder([]);
    setSelected("");
  }, [workspaceId, q, source]);
  const items = [...new Map([...older, ...(files.value?.items ?? [])].map((asset) => [asset.id, asset])).values()];
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      setNonce((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File, assetId?: string) =>
    act(async () => {
      let key = uploadKeys.current.get(file);
      if (!key) {
        key = crypto.randomUUID();
        uploadKeys.current.set(file, key);
      }
      const result = await client.uploadAsset(workspaceId, file, key, assetId);
      setSelected(result.asset.id);
      toast.success("文件已保存");
    });
  return (
    <div className="files-page">
      <PageTitle title="文件" description="管理工作区文件、历史版本与引用关系" />
      <input
        ref={input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <ErrorNotice
        error={error || files.error || workspaces.error || session.error}
        retry={() => setNonce((value) => value + 1)}
      />
      <div className="resource-toolbar files-toolbar" aria-label="文件工具栏">
        <label className="files-workspace">
          <span className="sr-only">工作区</span>
          <select value={workspaceId} onChange={(event) => setWorkspace(event.target.value)} aria-label="文件工作区">
            {workspaces.value?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.type}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="搜索文件"
          placeholder="搜索文件…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          maxLength={500}
        />
        <button className="primary" disabled={!workspaceId || busy} onClick={() => input.current?.click()}>
          <Icon name="upload" /> 上传文件
        </button>
        <details className="files-more" ref={more}>
          <summary aria-label="更多文件操作" title="更多文件操作">
            <Icon name="more" />
          </summary>
          <div className="files-menu">
            <button
              onClick={() => {
                setSyncOpen(!syncOpen);
                if (more.current) more.current.open = false;
              }}
            >
              同步 QQ 文件
            </button>
            <button
              onClick={() => {
                setNonce((value) => value + 1);
                if (more.current) more.current.open = false;
              }}
            >
              刷新
            </button>
          </div>
        </details>
        {sessionId && <a href={`#/workspace?session=${encodeURIComponent(sessionId)}`}>返回会话</a>}
      </div>
      {syncOpen && (
        <form
          className="resource-toolbar panel files-sync"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await client.syncFiles(channel, group, folder || undefined);
              toast.success("群文件来源已同步");
            });
          }}
        >
          <label>
            频道 ID
            <input value={channel} onChange={(event) => setChannel(event.target.value)} required />
          </label>
          <label>
            群号
            <input value={group} onChange={(event) => setGroup(event.target.value)} required />
          </label>
          <label>
            文件夹 ID（可选）
            <input value={folder} onChange={(event) => setFolder(event.target.value)} />
          </label>
          <button disabled={busy}>同步来源索引</button>
          <button type="button" onClick={() => setSyncOpen(false)}>
            收起
          </button>
        </form>
      )}
      <div className="tabs resource-tabs" role="tablist" aria-label="文件来源">
        {sources.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={source === key} onClick={() => setSource(key)}>
            {label}
          </button>
        ))}
      </div>
      {!workspaceId ? (
        <Empty title="尚无资源工作区" text="创建一次原生会话，或接收 QQ 文件后即可使用" />
      ) : (
        <div className={`files-layout ${selected ? "has-inspector" : ""}`}>
          <section ref={list} className="panel file-list" aria-label="工作区文件">
            <div className="file-list-heading">
              <span>
                {items.length} 个文件{files.value?.nextCursor ? " · 可加载更多" : ""}
              </span>
              <span>最近更新</span>
            </div>
            {files.loading && !items.length ? (
              <Loading />
            ) : !items.length ? (
              <Empty title="暂无文件" text="上传文件或同步 QQ 来源，内容会在预览或读取时按需获取" />
            ) : (
              <>
                <div className="file-columns" aria-hidden="true">
                  <span>名称</span>
                  <span>更新时间</span>
                  <span>状态</span>
                </div>
                {items.map((asset) => (
                  <button
                    className={`file-row ${selected === asset.id ? "selected" : ""}`}
                    key={asset.id}
                    aria-pressed={selected === asset.id}
                    aria-controls={selected === asset.id ? "file-inspector" : undefined}
                    onClick={() => setSelected(asset.id)}
                  >
                    <span className="file-name">
                      <span className="file-mark" aria-hidden="true">
                        <Icon name={asset.declaredMime?.startsWith("image/") ? "image" : "file"} />
                      </span>
                      <span>
                        <strong title={asset.displayName}>{asset.displayName}</strong>
                        <small>{asset.declaredMime || "文件"}</small>
                      </span>
                    </span>
                    <span className="file-updated">{time(asset.updatedAt)}</span>
                    <span className="resource-state">{assetState(asset)}</span>
                  </button>
                ))}
              </>
            )}
            {files.value?.nextCursor && (
              <button
                disabled={files.loading}
                onClick={() => {
                  setOlder(items);
                  setCursor(files.value!.nextCursor);
                }}
              >
                加载更多
              </button>
            )}
          </section>
          {selected && (
            <FileDetail
              key={selected}
              client={client}
              id={selected}
              revision={revision + nonce}
              disabled={busy}
              onChange={() => setNonce((value) => value + 1)}
              onReplace={(file) => void upload(file, selected)}
              onClose={closeInspector}
            />
          )}
        </div>
      )}
      {workspaceId && source === "mount" && (
        <MountBrowser
          key={workspaceId}
          client={client}
          workspaceId={workspaceId}
          onImported={(asset) => {
            setSelected(asset.id);
            setNonce((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function FileDetail({
  client,
  id,
  revision,
  disabled,
  onChange,
  onReplace,
  onClose
}: {
  client: RuntimeAdminClient;
  id: string;
  revision: number;
  disabled: boolean;
  onChange: () => void;
  onReplace: (file: File) => void;
  onClose: () => void;
}) {
  const detail = useLoad(
    useCallback(() => client.asset(id), [client, id]),
    revision
  );
  const [versionId, setVersionId] = useState("");
  const [rename, setRename] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<{ url: string; mime: string; text?: string; truncated?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const replacement = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    close.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview]
  );
  const data = detail.value;
  const version = data?.versions.find((item) => item.id === (versionId || data.asset.currentVersionId));
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      onChange();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const content = (download: boolean) =>
    act(async () => {
      const resolved: AssetVersionInfo = version ?? (await client.materializeAsset(id)).version;
      const blob = await client.downloadAsset(id, resolved.id);
      if (!mounted.current) return;
      const url = URL.createObjectURL(new Blob([blob], { type: resolved.detectedMime }));
      if (download) {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = data?.asset.displayName ?? "download";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const text = resolved.detectedMime.startsWith("text/plain") ? await blob.text() : undefined;
        // 关闭检查器后异步读取仍可能完成，此时没有组件负责释放预览 URL
        if (!mounted.current) {
          URL.revokeObjectURL(url);
          return;
        }
        setPreview({
          url,
          mime: resolved.detectedMime,
          ...(text === undefined ? {} : { text: text.slice(0, 64000), truncated: text.length > 64000 })
        });
      }
      setVersionId(resolved.id);
    });
  if (!data)
    return (
      <aside
        id="file-inspector"
        className="panel file-detail"
        aria-label="文件详情"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="file-detail-heading">
          <h2>文件详情</h2>
          <button ref={close} aria-label="关闭文件详情" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <ErrorNotice error={detail.error} retry={detail.reload} />
        {detail.loading && <Loading />}
      </aside>
    );
  return (
    <aside
      id="file-inspector"
      className="panel file-detail"
      aria-label="文件详情"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="file-detail-heading">
        <div>
          <h2>{data.asset.displayName}</h2>
          <small>
            {version?.detectedMime || data.asset.declaredMime || "文件"} ·{" "}
            {version ? `版本 ${version.versionNo}` : "尚未缓存"}
          </small>
        </div>
        <button ref={close} aria-label="关闭文件详情" title="关闭文件详情" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <ErrorNotice error={error || detail.error} retry={detail.reload} />
      <button
        className="file-preview-trigger"
        disabled={busy || disabled || !!data.asset.deletedAt}
        onClick={() => void content(false)}
      >
        <Icon name="eye" /> {busy ? "读取中…" : preview ? "重新加载预览" : "点击预览文件"}
      </button>
      {preview && (
        <div className="file-preview">
          {preview.text !== undefined ? (
            <>
              <pre>{preview.text}</pre>
              {preview.truncated && <p>预览已截断，下载可查看完整内容</p>}
            </>
          ) : preview.mime.startsWith("image/") ? (
            <img alt={data.asset.displayName} src={preview.url} />
          ) : preview.mime === "application/pdf" ? (
            <iframe title={data.asset.displayName} src={preview.url} sandbox="" />
          ) : (
            <p>此格式请下载后查看</p>
          )}
        </div>
      )}
      <div className="resource-toolbar file-actions">
        <button disabled={busy || disabled} onClick={() => void content(true)}>
          下载
        </button>
        <button disabled={busy || disabled || !!data.asset.deletedAt} onClick={() => replacement.current?.click()}>
          上传新版本
        </button>
      </div>
      <input
        ref={replacement}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onReplace(file);
        }}
      />
      <h3>文件信息</h3>
      <dl className="detail-facts">
        <dt>存储状态</dt>
        <dd>{assetState(data.asset)}</dd>
        <dt>更新于</dt>
        <dd>{time(data.asset.updatedAt)}</dd>
        <dt>版本数</dt>
        <dd>{data.versions.length} 个</dd>
        <dt>来源</dt>
        <dd>
          {[...new Set(data.sources.map((item) => sources.find(([key]) => key === item.kind)?.[1] ?? item.kind))].join(
            "、"
          ) || "—"}
        </dd>
      </dl>
      <h3>历史版本</h3>
      <label>
        内容版本
        <select
          aria-label="文件版本"
          value={versionId || data.asset.currentVersionId || ""}
          onChange={(event) => {
            setVersionId(event.target.value);
            setPreview(undefined);
          }}
        >
          <option value="" disabled>
            尚未获取内容
          </option>
          {data.versions.map((item) => (
            <option value={item.id} key={item.id}>
              v{item.versionNo} · {bytes(item.sizeBytes)} · {time(item.createdAt)}
            </option>
          ))}
        </select>
      </label>
      {version && (
        <div className="file-facts">
          <span>
            {version.detectedMime} · {bytes(version.sizeBytes)}
          </span>
          <code title={version.sha256}>SHA256 {version.sha256}</code>
        </div>
      )}
      {data.asset.fetchError && (
        <p role="status" className="notice error">
          {states[data.asset.fetchState ?? "fetch-failed"]} · {data.asset.fetchError}
        </p>
      )}
      <details>
        <summary>来源详情</summary>
        {data.sources.map((item) => (
          <div className="file-source" key={item.id}>
            <strong>{sources.find(([key]) => key === item.kind)?.[1] ?? item.kind}</strong>
            <small>
              首次发现 {time(item.observedAt)} · 最近发现 {time(item.lastSeenAt)}
            </small>
            <pre>{JSON.stringify(item.locator, null, 2)}</pre>
          </div>
        ))}
      </details>
      <h3>引用关系</h3>
      {data.refs.length ? (
        data.refs.map((ref, index) => (
          <div className="file-relation" key={`${ref.refType}:${ref.refId}:${index}`}>
            {ref.refType === "run" ? (
              <a href={`#/runs/${encodeURIComponent(ref.refId)}`}>查看运行</a>
            ) : (
              <span>{ref.refType}</span>
            )}
            <code>{ref.refId}</code>
            <small>{ref.versionId ? `版本 ${ref.versionId}` : "来源发现"}</small>
          </div>
        ))
      ) : (
        <p className="muted">尚未被运行引用</p>
      )}
      <details className="file-management">
        <summary>管理文件</summary>
        {!data.asset.deletedAt && (
          <form
            className="resource-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await client.renameAsset(id, rename);
                setRename("");
              });
            }}
          >
            <input
              aria-label="文件新名称"
              placeholder={data.asset.displayName}
              maxLength={255}
              value={rename}
              onChange={(event) => setRename(event.target.value)}
            />
            <button disabled={!rename.trim() || busy || disabled}>重命名</button>
          </form>
        )}
        {deleting && (
          <div className="notice">
            <span>从文件列表隐藏此文件，历史运行与远端原件仍保留</span>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await client.deleteAsset(id);
                  setDeleting(false);
                  onClose();
                })
              }
            >
              确认移除
            </button>
            <button onClick={() => setDeleting(false)}>取消</button>
          </div>
        )}
        <button disabled={busy || disabled || !!data.asset.deletedAt} onClick={() => setDeleting(!deleting)}>
          从文件列表移除
        </button>
      </details>
    </aside>
  );
}

function MountBrowser({
  client,
  workspaceId,
  onImported
}: {
  client: RuntimeAdminClient;
  workspaceId: string;
  onImported: (asset: AssetInfo) => void;
}) {
  const [mount, setMount] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounts = useLoad(
    useCallback(() => client.mounts(workspaceId), [client, workspaceId]),
    0
  );
  const entries = useLoad(
    useCallback(() => (mount ? client.mountEntries(mount, path) : Promise.resolve(undefined)), [client, mount, path]),
    0
  );
  if (!mounts.value?.items.length) return null;
  return (
    <section className="panel mount-browser">
      <div className="panel-heading">
        <h2>只读挂载目录</h2>
      </div>
      <ErrorNotice error={error || entries.error} retry={entries.reload} />
      <div className="resource-toolbar">
        <select
          aria-label="挂载目录"
          value={mount}
          onChange={(event) => {
            setMount(event.target.value);
            setPath("");
          }}
        >
          <option value="">选择目录</option>
          {mounts.value.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} · {item.access}
            </option>
          ))}
        </select>
        {path && <button onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>上级目录</button>}
        <code>{path || "/"}</code>
      </div>
      {entries.value?.items.map((entry) => (
        <div className="file-relation" key={entry.name}>
          <span>
            {entry.directory ? "目录" : "文件"} · {entry.name}
          </span>
          <button
            disabled={busy}
            onClick={() => {
              const target = [path, entry.name].filter(Boolean).join("/");
              if (entry.directory) setPath(target);
              else {
                setBusy(true);
                setError("");
                void client
                  .materializeMount(workspaceId, mount, target)
                  .then((result) => onImported(result.asset))
                  .catch((cause) => setError(message(cause)))
                  .finally(() => setBusy(false));
              }
            }}
          >
            {entry.directory ? "打开" : "保存为资源快照"}
          </button>
        </div>
      ))}
      {entries.value?.truncated && <p>目录超过 200 项，请选择更具体的子目录</p>}
    </section>
  );
}

function bytes(value: number) {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : value >= 1024
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${value} B`;
}

function assetState(asset: AssetInfo) {
  return (
    states[asset.deletedAt ? "deleted" : asset.currentVersionId ? "cached" : asset.fetchState || "remote-only"] ||
    "未知状态"
  );
}

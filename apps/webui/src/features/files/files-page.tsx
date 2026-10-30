import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetInfo, AssetVersionInfo, RuntimeAdminClient } from "@synapse/runtime-client";
import type { ViewProps } from "../../shared/types/runtime.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { PageTitle } from "../../shared/ui/content.js";
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
  deleted: "已删除"
};

/** 工作区独立文件入口，列表不下载内容，预览由用户显式发起 */
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
    <>
      <PageTitle
        title="Files"
        description="按工作区管理文件、历史版本与运行关系"
        action={
          <button className="primary" disabled={!workspaceId || busy} onClick={() => input.current?.click()}>
            上传文件
          </button>
        }
      />
      <input
        ref={input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <ErrorNotice
        error={error || files.error || workspaces.error || session.error}
        retry={() => setNonce((value) => value + 1)}
      />
      <div className="resource-toolbar">
        <label>
          工作区
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
          placeholder="搜索文件名"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          maxLength={500}
        />
        <button onClick={() => setSyncOpen(!syncOpen)}>同步 QQ 文件</button>
        <button onClick={() => setNonce((value) => value + 1)}>刷新</button>
        {sessionId && <a href={`#/workspace?session=${encodeURIComponent(sessionId)}`}>返回会话</a>}
      </div>
      {syncOpen && (
        <form
          className="resource-toolbar panel"
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
        <div className="files-layout">
          <section className="panel file-list" aria-label="工作区文件">
            {files.loading && !items.length ? (
              <Loading />
            ) : !items.length ? (
              <Empty title="暂无文件" text="上传文件或同步 QQ 来源，内容会在预览或读取时按需获取" />
            ) : (
              items.map((asset) => (
                <button
                  className={`file-row ${selected === asset.id ? "selected" : ""}`}
                  key={asset.id}
                  onClick={() => setSelected(asset.id)}
                >
                  <span className="file-mark" aria-hidden="true">
                    ▤
                  </span>
                  <span>
                    <strong>{asset.displayName}</strong>
                    <small>{time(asset.updatedAt)}</small>
                  </span>
                  <span className="resource-state">
                    {
                      states[
                        asset.deletedAt
                          ? "deleted"
                          : asset.currentVersionId
                            ? "cached"
                            : asset.fetchState || "remote-only"
                      ]
                    }
                  </span>
                </button>
              ))
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
          {selected ? (
            <FileDetail
              key={selected}
              client={client}
              id={selected}
              revision={revision + nonce}
              disabled={busy}
              onChange={() => setNonce((value) => value + 1)}
              onReplace={(file) => void upload(file, selected)}
            />
          ) : (
            <section className="panel">
              <Empty title="选择文件" text="查看来源、版本、内容与关联运行" />
            </section>
          )}
        </div>
      )}
      {workspaceId && (
        <MountBrowser
          client={client}
          workspaceId={workspaceId}
          onImported={(asset) => {
            setSelected(asset.id);
            setSource("mount");
            setNonce((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

function FileDetail({
  client,
  id,
  revision,
  disabled,
  onChange,
  onReplace
}: {
  client: RuntimeAdminClient;
  id: string;
  revision: number;
  disabled: boolean;
  onChange: () => void;
  onReplace: (file: File) => void;
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
      const url = URL.createObjectURL(new Blob([blob], { type: resolved.detectedMime }));
      if (download) {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = data?.asset.displayName ?? "download";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const text = resolved.detectedMime.startsWith("text/plain") ? await blob.text() : undefined;
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
      <section className="panel">
        <ErrorNotice error={detail.error} retry={detail.reload} />
        {detail.loading && <Loading />}
      </section>
    );
  return (
    <section className="panel file-detail">
      <div className="panel-heading">
        <h2>{data.asset.displayName}</h2>
        <span>{data.versions.length} 个版本</span>
      </div>
      <ErrorNotice error={error || detail.error} retry={detail.reload} />
      <div className="resource-toolbar">
        <button disabled={busy || disabled || !!data.asset.deletedAt} onClick={() => void content(false)}>
          {busy ? "读取中…" : "预览"}
        </button>
        <button disabled={busy || disabled} onClick={() => void content(true)}>
          下载
        </button>
        <button disabled={busy || disabled || !!data.asset.deletedAt} onClick={() => replacement.current?.click()}>
          上传新版本
        </button>
        <button disabled={busy || disabled || !!data.asset.deletedAt} onClick={() => setDeleting(!deleting)}>
          删除
        </button>
      </div>
      <input
        ref={replacement}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onReplace(file);
        }}
      />
      {deleting && (
        <div className="notice">
          <span>从 Files 隐藏此文件，历史运行与远端文件仍保留</span>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await client.deleteAsset(id);
                setDeleting(false);
              })
            }
          >
            确认删除
          </button>
          <button onClick={() => setDeleting(false)}>取消</button>
        </div>
      )}
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
          <button disabled={!rename.trim() || busy}>重命名</button>
        </form>
      )}
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
      <h3>来源</h3>
      {data.sources.map((item) => (
        <div className="file-source" key={item.id}>
          <strong>{sources.find(([key]) => key === item.kind)?.[1] ?? item.kind}</strong>
          <small>
            首次发现 {time(item.observedAt)} · 最近发现 {time(item.lastSeenAt)}
          </small>
          <pre>{JSON.stringify(item.locator, null, 2)}</pre>
        </div>
      ))}
      <h3>关联记录</h3>
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
    </section>
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

import { useCallback, useEffect, useState } from "react";
import type { InspectionPage, RuntimeAdminClient } from "@synapse/runtime-client";
import { Empty, ErrorNotice, Json, Loading, PageTitle, message, useLoad } from "./ui.js";
import { record, time } from "./model.js";

/** 分页浏览会话、消息、引用、提交与工件，所有读取保持会话作用域 */
export function Explorer({ client, initialSession }: { client: RuntimeAdminClient; initialSession: string }) {
  const [session, setSession] = useState(initialSession);
  const [tab, setTab] = useState("sessions");
  const [cursor, setCursor] = useState<string | number>();
  const [items, setItems] = useState<readonly Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown>>();
  const [commitId, setCommitId] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (initialSession) {
      setSession(initialSession);
      setTab("refs");
    }
  }, [initialSession]);
  useEffect(() => {
    setCursor(undefined);
    setItems([]);
    setSelected(undefined);
    setCommitId("");
    setError("");
  }, [session, tab]);
  const load = useCallback(async (): Promise<InspectionPage> => {
    if (tab === "sessions") return client.sessions(typeof cursor === "number" ? cursor : undefined);
    if (!session) return { ok: true, items: [] };
    if (tab === "transcript") return client.transcript(session, typeof cursor === "number" ? cursor : undefined);
    if (tab === "refs") return client.refs(session, typeof cursor === "string" ? cursor : undefined);
    return client.artifacts(session, typeof cursor === "string" ? cursor : undefined);
  }, [client, session, tab, cursor]);
  const data = useLoad(load);
  useEffect(() => {
    if (data.value)
      setItems((current) =>
        cursor === undefined
          ? data.value!.items
          : [
              ...current,
              ...data.value!.items.filter(
                (item) => !current.some((old) => JSON.stringify(old) === JSON.stringify(item))
              )
            ]
      );
  }, [data.value, cursor]);
  const openCommit = async (id: string) => {
    setError("");
    try {
      const result = record(await client.commit(session, id));
      setSelected(record(result.commit));
      setCommitId(id);
    } catch (cause) {
      setError(message(cause));
    }
  };
  const download = async () => {
    if (!selected?.id) return;
    setDownloading(true);
    setError("");
    try {
      const blob = await client.downloadArtifact(session, String(selected.id));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = String(selected.name ?? selected.id);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <>
      <PageTitle eyebrow="DATA EXPLORER" title="数据浏览" description="从会话走向上下文，检查每一份输入与产物。" />
      <form
        className="session-search"
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get("session");
          setSession(String(value ?? ""));
          setTab("refs");
        }}
      >
        <label>
          当前会话
          <input name="session" key={session} defaultValue={session} placeholder="选择会话或输入会话 ID" />
        </label>
        <button>打开会话 →</button>
      </form>
      <div className="tabs" role="tablist" aria-label="数据类型">
        {[
          ["sessions", "会话"],
          ["transcript", "消息"],
          ["refs", "引用与提交"],
          ["artifacts", "工件"]
        ].map(([value, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value!)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNotice error={data.error || error} retry={data.reload} />
      {tab !== "sessions" && !session ? (
        <Empty title="先选择一个会话" text="在会话列表中打开会话，或输入会话 ID" />
      ) : (
        <div className="inspector panel">
          <div className="data-list">
            <div className="panel-heading">
              <h2>
                {tab === "sessions"
                  ? "会话列表"
                  : tab === "transcript"
                    ? "消息记录"
                    : tab === "refs"
                      ? "上下文引用"
                      : "会话工件"}
              </h2>
              <button className="text-button" onClick={data.reload}>
                刷新
              </button>
            </div>
            {items.map((item, i) => (
              <button
                className={`data-item ${selected === item ? "selected" : ""}`}
                key={`${String(item.id ?? item.name)}:${i}`}
                onClick={() => {
                  setSelected(item);
                  setCommitId("");
                }}
              >
                <strong>{String(item.name ?? item.text ?? item.id ?? "记录")}</strong>
                <small>
                  {tab === "artifacts"
                    ? artifactDisposition(item.disposition)
                    : String(item.role ?? item.type ?? item.channelId ?? item.mimeType ?? "")}{" "}
                  · {time(item.createdAt ?? item.updatedAt)}
                </small>
              </button>
            ))}
            {!items.length && !data.loading && (
              <Empty title="暂无数据" text="此会话尚无该类记录，或数据已按保留策略清理" />
            )}
            {data.loading && <Loading />}
            {data.value?.nextCursor !== null && data.value?.nextCursor !== undefined && (
              <div className="load-more">
                <button disabled={data.loading} onClick={() => setCursor(data.value!.nextCursor!)}>
                  加载更多
                </button>
              </div>
            )}
          </div>
          <div className="event-detail">
            {selected ? (
              <>
                <span className="eyebrow">{commitId ? "IMMUTABLE COMMIT" : "RECORD DETAILS"}</span>
                <h2>{commitId ? "提交详情" : "记录详情"}</h2>
                {tab === "artifacts" && (
                  <p className="hint">
                    {artifactDisposition(selected.disposition)} · 生成和选择不代表已交付，请在运行时间线核对平台回执
                  </p>
                )}
                <div className="record-actions">
                  {tab === "sessions" && (
                    <button
                      className="primary"
                      onClick={() => {
                        setSession(String(selected.id));
                        setTab("refs");
                      }}
                    >
                      浏览此会话 →
                    </button>
                  )}
                  {tab === "refs" && !commitId && typeof selected.commitId === "string" && (
                    <button className="primary" onClick={() => void openCommit(selected.commitId as string)}>
                      查看引用头提交 →
                    </button>
                  )}
                  {tab === "artifacts" && (
                    <button className="primary" disabled={downloading} onClick={() => void download()}>
                      {downloading ? "下载中…" : "下载工件 ↓"}
                    </button>
                  )}
                </div>
                {commitId && <CommitParents commit={selected} open={(id) => void openCommit(id)} />}
                <Json value={selected} />
              </>
            ) : (
              <Empty title="选择一条记录" text="检查内容与归属，沿引用继续查看上下文提交" />
            )}
          </div>
        </div>
      )}
    </>
  );
}
function artifactDisposition(value: unknown): string {
  return value === "discarded" ? "已废弃" : value === "candidate" ? "候选文件 · 未选中" : "最终产物 · 已选中";
}
function CommitParents({ commit, open }: { commit: Record<string, unknown>; open: (id: string) => void }) {
  const parents = Array.isArray(commit.parents) ? commit.parents : [];
  return (
    <div className="commit-graph">
      <div className="commit-node">
        当前提交 <code>{String(commit.id).slice(0, 16)}</code>
      </div>
      {parents.length ? (
        <>
          <div className="graph-stem" />
          <div className="parent-nodes">
            {parents.map((parent) => (
              <button key={String(parent)} onClick={() => open(String(parent))}>
                父提交 ↗<code>{String(parent).slice(0, 16)}</code>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="hint">根提交 · 没有父节点</p>
      )}
    </div>
  );
}

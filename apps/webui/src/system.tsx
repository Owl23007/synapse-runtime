import { useCallback, useState } from "react";
import type { RuntimeAdminClient } from "@synapse/runtime-client";
import { Empty, ErrorNotice, Json, Loading, PageTitle, message, useLoad } from "./ui.js";
import { record, time } from "./model.js";

/** 频道与任务入口复用系统管理接口，所有操作后读取服务端真实状态 */
export function System({
  client,
  view = "system"
}: {
  client: RuntimeAdminClient;
  view?: "system" | "channels" | "tasks";
}) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmReload, setConfirmReload] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [status, tasks] = await Promise.all([client.status(), client.tasks()]);
    return { status: record(status), tasks: record(tasks) };
  }, [client]);
  const data = useLoad(load, revision);
  const status = data.value?.status ?? {};
  const runtime = record(status.runtime);
  const execution = record(runtime.execution);
  const channels = Array.isArray(status.channels) ? status.channels.map(record) : [];
  const tasks = Array.isArray(data.value?.tasks.tasks) ? data.value.tasks.tasks.map(record) : [];
  const act = async (id: string, operation: () => Promise<unknown>, success: string) => {
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await operation();
      setNotice(success);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageTitle
        title={view === "channels" ? "频道" : view === "tasks" ? "任务" : "系统状态"}
        description=""
        action={<button onClick={() => setRevision((value) => value + 1)}>刷新</button>}
      />
      <ErrorNotice error={error || data.error} retry={data.reload} />
      {notice && (
        <div role="status" className="notice success">
          {notice}
        </div>
      )}
      {data.loading && !data.value ? (
        <Loading />
      ) : (
        <>
          {view === "system" && (
            <div className="metrics">
              {[
                ["运行模式", runtime.mode],
                ["执行中", execution.active ?? execution.running ?? 0],
                ["排队中", execution.queued ?? 0],
                ["启动时间", time(runtime.startedAt)]
              ].map(([label, value]) => (
                <div className="metric system-metric" key={String(label)}>
                  <span>{String(label)}</span>
                  <strong>{String(value ?? "—")}</strong>
                </div>
              ))}
            </div>
          )}
          {view !== "tasks" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>频道连接</h2>
                <span className="count">{channels.length}</span>
              </div>
              {channels.length ? (
                channels.map((channel) => (
                  <div className="system-row" key={String(channel.id)}>
                    <span className={`dot ${channel.enabled ? "live" : ""}`} />
                    <div>
                      <strong>{String(channel.id)}</strong>
                      <small>
                        {String(channel.adapter ?? channel.provider ?? "频道")} ·{" "}
                        {String(record(channel.status).state ?? "未连接")}
                      </small>
                    </div>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void act(
                          String(channel.id),
                          () => client.updateChannel(String(channel.id), { enabled: !channel.enabled }),
                          channel.enabled ? "频道已停用" : "频道已启用"
                        )
                      }
                    >
                      {channel.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                ))
              ) : (
                <Empty title="尚未配置频道" text="原生会话可直接使用" />
              )}
            </section>
          )}
          {view !== "channels" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>活动任务</h2>
                <span className="count">{tasks.length}</span>
              </div>
              {tasks.length ? (
                tasks.map((task) => (
                  <div className="system-row" key={String(task.id)}>
                    <div>
                      <strong>{String(task.executor ?? task.id)}</strong>
                      <small>
                        {String(task.status)} · {String(task.id)}
                      </small>
                    </div>
                    {typeof task.sessionId === "string" && (
                      <a
                        className="button"
                        href={`#/workspace?session=${encodeURIComponent(task.sessionId)}&line=${encodeURIComponent(String(task.branchId ?? ""))}`}
                      >
                        打开分支 ↗
                      </a>
                    )}
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void act(String(task.id), () => client.cancelTask(String(task.id)), "已请求取消任务")
                      }
                    >
                      取消任务
                    </button>
                  </div>
                ))
              ) : (
                <Empty title="没有活动任务" text="" />
              )}
            </section>
          )}
          {view === "system" && (
            <section className="panel padded">
              <div className="system-setting">
                <div>
                  <h2>应用配置</h2>
                  <p>从配置文件重新加载</p>
                </div>
                <button disabled={!!busy} onClick={() => setConfirmReload(!confirmReload)}>
                  重新加载配置
                </button>
              </div>
              {confirmReload && (
                <div className="notice">
                  <span>确认应用配置文件中的最新修改？</span>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act(
                        "reload",
                        async () => {
                          await client.reload();
                          setConfirmReload(false);
                        },
                        "配置已重新加载"
                      )
                    }
                  >
                    确认重载
                  </button>
                </div>
              )}
              <details>
                <summary>Runtime 详情</summary>
                <Json value={status} />
              </details>
            </section>
          )}
        </>
      )}
    </>
  );
}

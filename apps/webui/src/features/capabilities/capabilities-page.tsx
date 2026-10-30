import { useCallback, useEffect, useState } from "react";
import type { CapabilityInfo, CatalogItem, RuntimeAdminClient } from "@synapse/runtime-client";
import type { ViewProps } from "../../shared/types/runtime.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { PageTitle } from "../../shared/ui/content.js";
import { Empty, ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { message, record, time } from "../../shared/lib/runtime.js";
import { toast } from "../../shared/lib/toast.js";
import "../files/files.css";
import "./capabilities.css";

const tabs = [
  ["discover", "发现"],
  ["installed", "已安装"],
  ["updates", "更新"],
  ["connections", "连接"]
] as const;
const connectionStates: Record<string, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  failed: "连接失败",
  "schema-changed": "工具定义已变化，需重新发现"
};

/** Runtime 能力管理入口，发现、安装与工作区授权保持独立 */
export function Capabilities({ client, revision }: ViewProps) {
  const [tab, setTab] = useState("installed");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const installed = useLoad(
    useCallback(() => client.capabilities(), [client]),
    revision + nonce
  );
  const workspaces = useLoad(
    useCallback(() => client.resourceWorkspaces(), [client]),
    revision + nonce
  );
  const workspaceId = workspace || workspaces.value?.items[0]?.id || "";
  const bindings = useLoad(
    useCallback(
      () => (workspaceId ? client.workspaceCapabilities(workspaceId) : Promise.resolve({ items: [] })),
      [client, workspaceId]
    ),
    revision + nonce
  );
  const connections = useLoad(
    useCallback(() => (tab === "connections" ? client.mcpConnections() : Promise.resolve(undefined)), [client, tab]),
    revision + nonce
  );
  const updates = useLoad(
    useCallback(() => (tab === "updates" ? client.capabilityUpdates() : Promise.resolve(undefined)), [client, tab]),
    revision + nonce
  );
  const items = installed.value?.items ?? [];
  const selected = items.find((item) => item.id === selectedId);
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
  return (
    <>
      <PageTitle
        title="Capabilities"
        description="Runtime 安装能力，Workspace 选择启用版本"
        action={<button onClick={() => setNonce((value) => value + 1)}>刷新</button>}
      />
      <ErrorNotice
        error={error || installed.error || workspaces.error || bindings.error || connections.error || updates.error}
        retry={() => setNonce((value) => value + 1)}
      />
      <div className="tabs resource-tabs" role="tablist" aria-label="能力管理">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "discover" && (
        <Discover
          client={client}
          busy={busy}
          onInstall={(input) =>
            act(async () => {
              const result = await client.installCapability(input);
              setSelectedId(result.installation.id);
              setTab("installed");
              toast.success("安装完成，请审阅内容后选择工作区启用");
            })
          }
        />
      )}
      {tab === "installed" && (
        <>
          <div className="resource-toolbar">
            <label>
              工作区
              <select
                aria-label="能力工作区"
                value={workspaceId}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                {workspaces.value?.items.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.type}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">安装不会自动启用；版本切换与回滚只影响后续运行</span>
          </div>
          {installed.loading && !installed.value ? (
            <Loading />
          ) : !items.length ? (
            <Empty title="尚未安装能力" text="在发现页选择精确版本，或在配置中声明远程 MCP 连接" />
          ) : (
            <div className="capability-layout">
              <section className="capability-list panel">
                {items.map((item) => {
                  const binding = bindings.value?.items.find((value) => value.packageKey === item.packageKey);
                  return (
                    <button
                      className={`file-row ${selectedId === item.id ? "selected" : ""}`}
                      onClick={() => setSelectedId(item.id)}
                      key={item.id}
                    >
                      <span className="capability-kind">{item.kind === "skill" ? "S" : "M"}</span>
                      <span>
                        <strong>{String(item.metadata.name ?? item.packageKey)}</strong>
                        <small>
                          {item.sourceVersion ?? item.sourceRevision?.slice(0, 12) ?? item.contentDigest.slice(0, 12)}
                        </small>
                        <small>{item.packageKey}</small>
                      </span>
                      <span className="resource-state">
                        {binding?.enabled && binding.installId === item.id ? "此工作区已启用" : "已安装 · 未启用"}
                      </span>
                    </button>
                  );
                })}
              </section>
              {selected ? (
                <CapabilityDetail
                  key={selected.id}
                  client={client}
                  installation={selected}
                  versions={items.filter((item) => item.packageKey === selected.packageKey)}
                  busy={busy}
                  binding={bindings.value?.items.find((item) => item.packageKey === selected.packageKey)}
                  workspaceId={workspaceId}
                  onSelect={setSelectedId}
                  onBind={(enabled, settings) =>
                    act(async () => {
                      await client.bindCapability(workspaceId, selected.packageKey, {
                        installId: selected.id,
                        enabled,
                        settings
                      });
                      toast.success(enabled ? "工作区版本已启用" : "工作区能力已停用");
                    })
                  }
                  onCheck={() =>
                    act(async () => {
                      await client.checkCapabilityUpdates(selected.id);
                      setTab("updates");
                    })
                  }
                />
              ) : (
                <section className="panel">
                  <Empty title="选择安装版本" text="审阅说明、文件、脚本与来源，再为工作区启用" />
                </section>
              )}
            </div>
          )}
        </>
      )}
      {tab === "updates" && (
        <section className="panel capability-panel">
          <div className="panel-heading">
            <h2>来源更新</h2>
            <button
              disabled={busy || !items.length}
              onClick={() =>
                void act(async () => {
                  for (const item of items) await client.checkCapabilityUpdates(item.id);
                  toast.success("更新检查完成");
                })
              }
            >
              {busy ? "检查中…" : "检查全部"}
            </button>
          </div>
          <p className="muted">检查只读取来源版本；新版本需要明确安装并手动切换工作区</p>
          {updates.loading && !updates.value ? (
            <Loading />
          ) : updates.value?.items.length ? (
            updates.value.items.map((update, index) => (
              <div className="capability-update" key={`${String(update.installId)}:${index}`}>
                <strong>
                  {items.find((item) => item.id === update.installId)?.packageKey ?? String(update.installId)}
                </strong>
                <span>{update.available ? "发现新版本" : "未发现更新"}</span>
                <small>
                  当前 {String(update.currentVersion ?? update.currentRevision ?? "配置快照")} → 最新{" "}
                  {String(update.latestVersion ?? update.latestRevision ?? "—")}
                </small>
                <small>{time(update.checkedAt)}</small>
                {update.available === true && <button onClick={() => setTab("discover")}>前往安装新版本</button>}
              </div>
            ))
          ) : (
            <Empty title="尚无检查结果" text="使用检查按钮，或等待已配置的自动检查任务" />
          )}
        </section>
      )}
      {tab === "connections" && (
        <div className="connection-grid">
          {connections.loading && !connections.value ? (
            <Loading />
          ) : connections.value?.items.length ? (
            connections.value.items.map((connection) => (
              <section className="panel capability-panel" key={connection.installId}>
                <div className="panel-heading">
                  <h2>{connection.packageKey}</h2>
                  <span className="resource-state">{connectionStates[connection.state] ?? connection.state}</span>
                </div>
                {connection.error && (
                  <p role="status" className="notice error">
                    {connection.error}
                  </p>
                )}
                <dl className="capability-facts">
                  <dt>所需用户权限</dt>
                  <dd>
                    <code>{connection.permissionAction ?? "连接后可查看"}</code>
                  </dd>
                  <dt>协议版本</dt>
                  <dd>{connection.protocolVersion ?? "尚未协商"}</dd>
                  <dt>远端版本</dt>
                  <dd>
                    {connection.serverVersion
                      ? `${connection.serverVersion.name}@${connection.serverVersion.version}`
                      : "尚未观察"}
                  </dd>
                  <dt>工具摘要</dt>
                  <dd>
                    <code>{connection.observedToolSetDigest ?? "—"}</code>
                  </dd>
                </dl>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await client.reconnectMcp(connection.installId);
                      toast.success("连接与工具定义已重新发现");
                    })
                  }
                >
                  连接 / 重新发现
                </button>
                <p className="muted">远程服务版本不能完全锁定；写操作结果未知时需核对服务端，不自动重放</p>
                {connection.tools.map((tool) => (
                  <details key={tool.name}>
                    <summary>{tool.name}</summary>
                    <p>{tool.description}</p>
                    <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  </details>
                ))}
              </section>
            ))
          ) : (
            <Empty title="尚无 MCP 连接" text="从官方 Registry 安装远程 HTTP 服务，或在配置中声明连接" />
          )}
        </div>
      )}
    </>
  );
}

function Discover({
  client,
  busy,
  onInstall
}: {
  client: RuntimeAdminClient;
  busy: boolean;
  onInstall: (input: unknown) => Promise<void>;
}) {
  const [provider, setProvider] = useState("clawhub");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<CatalogItem>();
  const [version, setVersion] = useState("");
  const [revision, setRevision] = useState("");
  const [directory, setDirectory] = useState("");
  const [endpoint, setEndpoint] = useState(0);
  const results = useLoad(
    useCallback(
      () => (searching && provider !== "github" ? client.searchCatalog(provider, query) : Promise.resolve(undefined)),
      [client, provider, query, searching]
    ),
    0
  );
  const versions = useLoad(
    useCallback(
      () => (selected ? client.catalogVersions(selected.provider, selected.packageId) : Promise.resolve(undefined)),
      [client, selected]
    ),
    0
  );
  useEffect(() => {
    setSelected(undefined);
    setSearching(false);
    setVersion("");
  }, [provider]);
  return (
    <>
      <form
        className="resource-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(q);
          setSearching(true);
        }}
      >
        <label>
          来源
          <select aria-label="能力目录来源" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="clawhub">ClawHub Skills</option>
            <option value="mcp-official">官方 MCP Registry</option>
            <option value="github">GitHub 固定提交</option>
          </select>
        </label>
        <input
          aria-label={provider === "github" ? "GitHub 仓库" : "搜索能力"}
          placeholder={provider === "github" ? "owner/repository" : "搜索 Skill 或 MCP 服务"}
          maxLength={500}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        {provider !== "github" && <button>搜索</button>}
      </form>
      <ErrorNotice error={results.error || versions.error} retry={results.reload} />
      {provider === "github" ? (
        <form
          className="panel capability-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void onInstall({ provider: "github", packageId: q, revision, ...(directory ? { directory } : {}) });
          }}
        >
          <h2>安装 GitHub Skill 快照</h2>
          <label>
            完整 Commit SHA
            <input
              required
              pattern="[a-f0-9]{40}"
              aria-label="完整 Commit SHA"
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
            />
          </label>
          <label>
            仓库内 Skill 目录（可选）
            <input
              aria-label="Skill 子目录"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              placeholder="skills/report-analysis"
            />
          </label>
          <p className="muted">只安装已固定提交的标准 SKILL.md 目录。脚本仅保存供审阅，不会执行</p>
          <button className="primary" disabled={busy || !q || !/^[a-f0-9]{40}$/.test(revision)}>
            安装固定快照
          </button>
        </form>
      ) : (
        <div className="capability-layout">
          <section className="panel capability-list">
            {results.loading ? (
              <Loading />
            ) : results.value?.items.length ? (
              results.value.items.map((item) => (
                <button
                  className="file-row"
                  key={item.packageId}
                  onClick={() => {
                    setSelected(item);
                    setVersion("");
                    setEndpoint(0);
                  }}
                >
                  <span className="capability-kind">{item.provider === "clawhub" ? "S" : "M"}</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description.slice(0, 180)}</small>
                    <small>{item.packageId}</small>
                  </span>
                </button>
              ))
            ) : (
              <Empty
                title={searching ? "没有匹配结果" : "发现第三方能力"}
                text="搜索只读取目录元数据，安装与工作区启用需要分别操作"
              />
            )}
          </section>
          {selected && (
            <section className="panel capability-panel">
              <h2>{selected.name}</h2>
              <p>{selected.description}</p>
              <dl className="capability-facts">
                <dt>来源</dt>
                <dd>
                  {selected.provider} · {selected.packageId}
                </dd>
                <dt>作者</dt>
                <dd>{selected.author ?? "查看来源目录"}</dd>
                <dt>许可证</dt>
                <dd>{selected.license ?? "安装后审阅包内许可证"}</dd>
              </dl>
              {safeLink(selected.url) && (
                <a href={safeLink(selected.url)} rel="noreferrer" target="_blank">
                  查看来源
                </a>
              )}
              <label>
                精确版本
                <select aria-label="安装版本" value={version} onChange={(event) => setVersion(event.target.value)}>
                  <option value="">选择发布版本</option>
                  {versions.value?.items.map((item) => (
                    <option key={item.version} value={item.version}>
                      {item.version}
                    </option>
                  ))}
                </select>
              </label>
              {versions.value?.items.find((item) => item.version === version)?.changelog && (
                <pre>{versions.value.items.find((item) => item.version === version)!.changelog}</pre>
              )}
              {selected.provider === "mcp-official" && (
                <label>
                  远程 HTTP 端点
                  <select
                    aria-label="MCP 端点"
                    value={endpoint}
                    onChange={(event) => setEndpoint(Number(event.target.value))}
                  >
                    {selected.remotes
                      ?.filter((remote) => remote.type === "streamable-http")
                      .map((remote, index) => (
                        <option key={remote.url} value={index}>
                          {remote.url}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <p className="muted">第三方内容与扫描结果不代表安全认证。安装不会执行脚本，也不会自动为工作区授予权限</p>
              <button
                className="primary"
                disabled={busy || !version}
                onClick={() =>
                  void onInstall({
                    provider: selected.provider,
                    packageId: selected.packageId,
                    version,
                    ...(selected.provider === "mcp-official" ? { endpointIndex: endpoint } : {})
                  })
                }
              >
                {busy ? "安装中…" : "安装此版本"}
              </button>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function CapabilityDetail({
  client,
  installation,
  versions,
  busy,
  workspaceId,
  binding,
  onSelect,
  onBind,
  onCheck
}: {
  client: RuntimeAdminClient;
  installation: CapabilityInfo;
  versions: readonly CapabilityInfo[];
  busy: boolean;
  workspaceId: string;
  binding: import("@synapse/runtime-client").CapabilityBinding | undefined;
  onSelect: (id: string) => void;
  onBind: (enabled: boolean, settings: Readonly<Record<string, unknown>>) => Promise<void>;
  onCheck: () => Promise<void>;
}) {
  const [path, setPath] = useState(installation.kind === "skill" ? "SKILL.md" : "");
  const [requiredTools, setRequiredTools] = useState(
    Array.isArray(binding?.settings.requiredTools) ? binding.settings.requiredTools.join(", ") : ""
  );
  const resource = useLoad(
    useCallback(
      () =>
        installation.kind === "skill" && path
          ? client.capabilityResource(installation.id, path)
          : Promise.resolve(undefined),
      [client, installation.id, installation.kind, path]
    ),
    0
  );
  const files = Array.isArray(installation.metadata.files) ? installation.metadata.files.map(record) : [];
  const active = binding?.enabled && binding.installId === installation.id;
  return (
    <section className="panel capability-panel">
      <div className="panel-heading">
        <h2>{String(installation.metadata.name ?? installation.packageKey)}</h2>
        <span>{installation.kind.toUpperCase()}</span>
      </div>
      <p>{String(installation.metadata.description ?? "")}</p>
      <dl className="capability-facts">
        <dt>包身份</dt>
        <dd>{installation.packageKey}</dd>
        <dt>来源版本</dt>
        <dd>{installation.sourceVersion ?? installation.sourceRevision ?? "连接配置快照"}</dd>
        <dt>许可证</dt>
        <dd>{String(installation.metadata.license ?? "未声明，请审阅来源")}</dd>
        <dt>内容摘要</dt>
        <dd>
          <code>{installation.contentDigest}</code>
        </dd>
        <dt>运行环境</dt>
        <dd>{installation.kind === "skill" ? "说明与只读资源；脚本不执行" : "远程 Streamable HTTP"}</dd>
        <dt>安装时间</dt>
        <dd>{time(installation.installedAt)}</dd>
      </dl>
      <label>
        已安装版本 / 回滚
        <select aria-label="已安装能力版本" value={installation.id} onChange={(event) => onSelect(event.target.value)}>
          {versions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.sourceVersion ?? item.sourceRevision?.slice(0, 12) ?? item.contentDigest.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      {installation.kind === "skill" && (
        <label>
          必需工具（逗号分隔，可选）
          <input
            value={requiredTools}
            onChange={(event) => setRequiredTools(event.target.value)}
            aria-label="Skill 必需工具"
          />
        </label>
      )}
      <div className="resource-toolbar">
        <button
          className="primary"
          disabled={busy || !workspaceId || active}
          onClick={() =>
            void onBind(true, {
              requiredTools: requiredTools
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            })
          }
        >
          {active ? "此工作区已启用" : binding?.enabled ? "切换至此版本" : "为此工作区启用"}
        </button>
        {active && (
          <button disabled={busy} onClick={() => void onBind(false, binding.settings)}>
            停用
          </button>
        )}
        <button disabled={busy} onClick={() => void onCheck()}>
          检查更新
        </button>
      </div>
      <p className="muted">Workspace 启用与用户权限同时生效，Skill 不会新增执行权限；旧 Run 保留原版本引用</p>
      {files.length > 0 && (
        <>
          <label>
            审阅文件
            <select aria-label="Skill 文件" value={path} onChange={(event) => setPath(event.target.value)}>
              {files.map((file) => (
                <option key={String(file.path)} value={String(file.path)}>
                  {String(file.path)}
                  {String(file.path).startsWith("scripts/") ? " · 脚本" : ""}
                </option>
              ))}
            </select>
          </label>
          <ErrorNotice error={resource.error} retry={resource.reload} />
          {resource.loading ? (
            <Loading />
          ) : (
            <pre className="skill-source">
              {resource.value?.resource.binary ? "二进制辅助资源" : resource.value?.resource.text}
              {resource.value?.resource.hasMore ? "\n… 内容已截断" : ""}
            </pre>
          )}
        </>
      )}
      <details>
        <summary>安装来源与元数据</summary>
        <pre>{JSON.stringify({ source: installation.source, metadata: installation.metadata }, null, 2)}</pre>
      </details>
    </section>
  );
}

function safeLink(value?: string): string | undefined {
  try {
    if (!value) return;
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

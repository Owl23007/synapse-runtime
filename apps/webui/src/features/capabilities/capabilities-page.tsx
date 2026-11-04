import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { CapabilityInfo, CatalogItem, RuntimeAdminClient } from "@synapse/runtime-client";
import type { ViewProps } from "../../shared/types/runtime.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { PageTitle } from "../../shared/ui/content.js";
import { ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { Icon } from "../../shared/ui/icons.js";
import { navigateTabs } from "../../shared/ui/tabs.js";
import { message, record, time } from "../../shared/lib/runtime.js";
import { toast } from "../../shared/lib/toast.js";
import "./capabilities.css";

const tabs = [
  ["discover", "发现", "search"],
  ["installed", "已安装", "workspace"],
  ["updates", "更新", "refresh"],
  ["connections", "连接", "plug"]
] as const;
const catalogSources = [
  {
    id: "clawhub",
    name: "ClawHub Skills",
    label: "SKILLS",
    icon: "file",
    description: "发现可复用的技能，拓展智能体的工作方式"
  },
  {
    id: "mcp-official",
    name: "MCP Registry",
    label: "MCP",
    icon: "server",
    description: "连接远程工具与服务，让工作区拥有更多能力"
  },
  {
    id: "github",
    name: "GitHub",
    label: "REPOSITORY",
    icon: "branch",
    description: "从仓库安装固定版本，管理自己的 Skill"
  }
] as const;
const connectionStates: Record<string, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  failed: "连接失败",
  "schema-changed": "工具定义已变化，需重新发现"
};

/** 能力中心统一呈现目录、安装版本与连接状态，工作区启用仍需单独操作 */
export function Capabilities({ client, revision }: ViewProps) {
  const tabId = useId();
  const [tab, setTab] = useState("installed");
  const [provider, setProvider] = useState("clawhub");
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
  const enabledCount = bindings.value?.items.filter((binding) => binding.enabled).length;
  const discover = (source = "clawhub") => {
    setProvider(source);
    setTab("discover");
  };
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
    <div className="capabilities-page">
      <div className="capability-heading">
        <span className="capability-heading-icon">
          <Icon name="plug" />
        </span>
        <PageTitle
          title="能力中心"
          description="发现技能与工具，为你的工作区拓展更多可能"
          action={
            <div className="capability-actions">
              <button onClick={() => setNonce((value) => value + 1)}>
                <Icon name="refresh" />
                刷新
              </button>
              <button className="primary" onClick={() => discover()}>
                <Icon name="plus" />
                发现能力
              </button>
            </div>
          }
        />
      </div>
      <dl className="capability-overview" aria-label="能力概览">
        <div>
          <dt>
            <Icon name="workspace" />
            已安装版本
          </dt>
          <dd>
            {installed.value ? items.length : "—"}
            <small>个版本</small>
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="file" />
            Skills
          </dt>
          <dd>
            {installed.value ? items.filter((item) => item.kind === "skill").length : "—"}
            <small>个技能版本</small>
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="server" />
            MCP 服务
          </dt>
          <dd>
            {installed.value ? items.filter((item) => item.kind !== "skill").length : "—"}
            <small>个安装版本</small>
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="check" />
            工作区已启用
          </dt>
          <dd>
            {enabledCount ?? "—"}
            <small>项能力</small>
          </dd>
        </div>
      </dl>
      <ErrorNotice
        error={error || installed.error || workspaces.error || bindings.error || connections.error || updates.error}
        retry={() => setNonce((value) => value + 1)}
      />
      <div className="tabs capability-tabs" role="tablist" aria-label="能力管理" onKeyDown={navigateTabs}>
        {tabs.map(([key, label, icon]) => (
          <button
            key={key}
            id={`${tabId}-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`${tabId}-panel`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
          >
            <Icon name={icon} />
            {label}
            {key === "installed" && installed.value && <span className="capability-tab-count">{items.length}</span>}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={`${tabId}-${tab}`}
        tabIndex={0}
        className="capability-content"
      >
        {tab === "discover" && (
          <Discover
            client={client}
            busy={busy}
            provider={provider}
            onProviderChange={setProvider}
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
            <div className="capability-workspace-bar">
              <div className="capability-workspace-select">
                <Icon name="workspace" />
                <label>
                  <span>当前工作区</span>
                  <select
                    aria-label="能力工作区"
                    value={workspaceId}
                    onChange={(event) => setWorkspace(event.target.value)}
                  >
                    {!workspaces.value?.items.length && (
                      <option value="">{workspaces.loading ? "正在加载…" : "暂无工作区"}</option>
                    )}
                    {workspaces.value?.items.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name} · {item.type}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="capability-workspace-hint">
                <Icon name="lock" />
                安装后，按工作区独立启用
              </span>
            </div>
            {installed.loading && !installed.value ? (
              <Loading />
            ) : !items.length ? (
              <>
                <CapabilityEmpty
                  icon="plug"
                  title="让工作区拥有更多能力"
                  text="添加 Skills 和 MCP 服务，把可复用的技能与外部工具带入日常工作"
                  action={
                    <button className="primary" onClick={() => discover()}>
                      <Icon name="plus" />
                      发现并安装能力
                      <Icon name="arrowRight" />
                    </button>
                  }
                />
                <div className="capability-section-heading">
                  <h2>从这里开始探索</h2>
                  <span>选择适合你的能力来源</span>
                </div>
                <CatalogSources onSelect={discover} />
              </>
            ) : (
              <div className="capability-layout">
                <section className="capability-list panel">
                  <div className="capability-list-heading">
                    <h2>已安装能力</h2>
                    <span>{items.length} 个版本</span>
                  </div>
                  {items.map((item) => {
                    const binding = bindings.value?.items.find((value) => value.packageKey === item.packageKey);
                    return (
                      <button
                        className={`capability-row ${selectedId === item.id ? "selected" : ""}`}
                        aria-pressed={selectedId === item.id}
                        onClick={() => setSelectedId(item.id)}
                        key={item.id}
                      >
                        <CapabilityKind skill={item.kind === "skill"} />
                        <span className="capability-row-body">
                          <strong>{String(item.metadata.name ?? item.packageKey)}</strong>
                          <small className="capability-version">
                            {item.kind === "skill" ? "Skill" : "MCP"} ·{" "}
                            {item.sourceVersion ?? item.sourceRevision?.slice(0, 12) ?? item.contentDigest.slice(0, 12)}
                          </small>
                          <small>{item.packageKey}</small>
                        </span>
                        <span
                          className={`capability-state ${binding?.enabled && binding.installId === item.id ? "is-enabled" : ""}`}
                        >
                          <span className="dot" />
                          {binding?.enabled && binding.installId === item.id ? "已启用" : "未启用"}
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
                  <CapabilityEmpty
                    icon="panel"
                    title="查看能力详情"
                    text="从左侧选择一个版本，审阅说明与来源，再为工作区启用"
                  />
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
                <Icon name="refresh" />
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
                  <span className={`capability-state ${update.available ? "has-update" : "is-enabled"}`}>
                    <Icon name={update.available ? "arrowUp" : "check"} />
                    {update.available ? "发现新版本" : "未发现更新"}
                  </span>
                  <small>
                    当前 {String(update.currentVersion ?? update.currentRevision ?? "配置快照")} → 最新{" "}
                    {String(update.latestVersion ?? update.latestRevision ?? "—")}
                  </small>
                  <small>{time(update.checkedAt)}</small>
                  {update.available === true && <button onClick={() => setTab("discover")}>前往安装新版本</button>}
                </div>
              ))
            ) : (
              <CapabilityEmpty
                icon="refresh"
                title="尚无更新检查结果"
                text={
                  items.length ? "点击“检查全部”，查看已安装能力的最新版本" : "安装能力后，可以在这里检查来源版本与更新"
                }
              />
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
                    <span
                      className={`capability-state ${connection.state === "connected" ? "is-enabled" : connection.state === "failed" || connection.state === "schema-changed" ? "has-error" : ""}`}
                    >
                      <span className="dot" />
                      {connectionStates[connection.state] ?? connection.state}
                    </span>
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
              <CapabilityEmpty
                icon="server"
                title="连接工具，拓展工作边界"
                text="从 MCP Registry 安装远程 HTTP 服务，或在配置中声明连接"
                action={
                  <button onClick={() => discover("mcp-official")}>
                    <Icon name="plus" />
                    浏览 MCP 服务
                    <Icon name="arrowRight" />
                  </button>
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Discover({
  client,
  busy,
  provider,
  onProviderChange,
  onInstall
}: {
  client: RuntimeAdminClient;
  busy: boolean;
  provider: string;
  onProviderChange: (provider: string) => void;
  onInstall: (input: unknown) => Promise<void>;
}) {
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
      <div className="capability-section-heading">
        <div>
          <h2>发现新能力</h2>
          <p>从技能目录、工具服务或代码仓库中选择</p>
        </div>
      </div>
      <CatalogSources selected={provider} onSelect={onProviderChange} />
      <form
        className="capability-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (searching && query === q) results.reload();
          setQuery(q);
          setSearching(true);
        }}
      >
        <Icon name={provider === "github" ? "branch" : "search"} />
        <input
          aria-label={provider === "github" ? "GitHub 仓库" : "搜索能力"}
          placeholder={
            provider === "github"
              ? "输入 GitHub 仓库，例如 owner/repository"
              : provider === "clawhub"
                ? "在 ClawHub 中搜索 Skills…"
                : "在 MCP Registry 中搜索工具与服务…"
          }
          maxLength={500}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        {provider !== "github" && (
          <button className="primary" disabled={results.loading && searching}>
            搜索能力
            <Icon name="arrowRight" />
          </button>
        )}
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
        <div className={`capability-layout ${selected ? "" : "is-browsing"}`}>
          <section className="panel capability-list">
            {searching && (
              <div className="capability-list-heading">
                <h2>搜索结果</h2>
                <span>{results.value?.items.length ?? 0} 项能力</span>
              </div>
            )}
            {results.loading ? (
              <Loading />
            ) : results.value?.items.length ? (
              results.value.items.map((item) => (
                <button
                  className={`capability-row ${selected?.packageId === item.packageId ? "selected" : ""}`}
                  aria-pressed={selected?.packageId === item.packageId}
                  key={item.packageId}
                  onClick={() => {
                    setSelected(item);
                    setVersion("");
                    setEndpoint(0);
                  }}
                >
                  <CapabilityKind skill={item.provider === "clawhub"} />
                  <span className="capability-row-body">
                    <strong>{item.name}</strong>
                    <small>{item.description.slice(0, 180)}</small>
                    <small>{item.packageId}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))
            ) : (
              <CapabilityEmpty
                icon="search"
                title={searching ? "没有匹配结果" : "发现第三方能力"}
                text="搜索只读取目录元数据，安装与工作区启用需要分别操作"
              />
            )}
          </section>
          {selected && (
            <section className="panel capability-panel">
              <div className="capability-detail-heading">
                <CapabilityKind skill={selected.provider === "clawhub"} />
                <div>
                  <span className="capability-eyebrow">
                    {selected.provider === "clawhub" ? "SKILL" : "MCP SERVICE"}
                  </span>
                  <h2>{selected.name}</h2>
                </div>
              </div>
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
                  查看来源 <Icon name="arrowRight" />
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
                <Icon name="plus" />
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
      <div className="capability-detail-heading">
        <CapabilityKind skill={installation.kind === "skill"} />
        <div>
          <span className="capability-eyebrow">{installation.kind === "skill" ? "SKILL" : "MCP SERVICE"}</span>
          <h2>{String(installation.metadata.name ?? installation.packageKey)}</h2>
        </div>
        <span className={`capability-state ${active ? "is-enabled" : ""}`}>
          <span className="dot" />
          {active ? "已启用" : "未启用"}
        </span>
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
          <Icon name="check" />
          {active ? "此工作区已启用" : binding?.enabled ? "切换至此版本" : "为此工作区启用"}
        </button>
        {active && (
          <button disabled={busy} onClick={() => void onBind(false, binding.settings)}>
            停用
          </button>
        )}
        <button disabled={busy} onClick={() => void onCheck()}>
          <Icon name="refresh" />
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

function CapabilityKind({ skill }: { skill: boolean }) {
  return (
    <span className={`capability-kind ${skill ? "is-skill" : "is-mcp"}`}>
      <Icon name={skill ? "file" : "server"} />
    </span>
  );
}

function CatalogSources({ selected, onSelect }: { selected?: string; onSelect: (provider: string) => void }) {
  return (
    <div className="capability-sources" aria-label="能力来源">
      {catalogSources.map((source) => (
        <button
          key={source.id}
          className={`capability-source ${selected === source.id ? "selected" : ""}`}
          aria-pressed={selected === undefined ? undefined : selected === source.id}
          onClick={() => onSelect(source.id)}
        >
          <span className="capability-source-top">
            <span className={`capability-kind source-${source.id}`}>
              <Icon name={source.icon} />
            </span>
            <span className="capability-eyebrow">{source.label}</span>
            {selected === source.id ? <Icon name="check" /> : <Icon name="arrowRight" />}
          </span>
          <strong>{source.name}</strong>
          <span className="capability-source-description">{source.description}</span>
        </button>
      ))}
    </div>
  );
}

function CapabilityEmpty({
  icon,
  title,
  text,
  action
}: {
  icon: "plug" | "panel" | "refresh" | "server" | "search";
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="capability-empty">
      <div className="capability-empty-art" aria-hidden="true">
        <span className="capability-empty-orbit" />
        <span className="capability-empty-icon">
          <Icon name={icon} />
        </span>
        <span className="capability-empty-spark">
          <Icon name="plus" />
        </span>
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && <div className="capability-empty-action">{action}</div>}
    </div>
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

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import type { CapabilityBinding, CapabilityInfo, CatalogItem, RuntimeAdminClient } from "@synapse/runtime-client";
import type { ViewProps } from "../../shared/types/runtime.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { PageTitle } from "../../shared/ui/content.js";
import { Loading } from "../../shared/ui/feedback.js";
import { Icon } from "../../shared/ui/icons.js";
import { navigateTabs } from "../../shared/ui/tabs.js";
import { message, record, time } from "../../shared/lib/runtime.js";
import { toast } from "../../shared/lib/toast.js";
import { capabilityIssue, catalogItemState } from "./capability-presentation.js";
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
    name: "Skills 市场",
    label: "ClawHub · 搜索可复用技能",
    icon: "file",
    description: "ClawHub Skills"
  },
  {
    id: "mcp-official",
    name: "MCP Registry",
    label: "搜索远程工具与服务",
    icon: "server",
    description: "MCP Registry"
  },
  {
    id: "github",
    name: "GitHub 仓库",
    label: "从仓库安装固定提交",
    icon: "branch",
    description: "GitHub"
  }
] as const;
const connectionStates: Record<string, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  failed: "连接失败",
  "schema-changed": "工具定义已变化，需重新发现"
};

/** 能力中心默认进入发现流程，错误按任务局部呈现，安装与工作区启用保持独立 */
export function Capabilities({ client, revision }: ViewProps) {
  const tabId = useId();
  const [tab, setTab] = useState("discover");
  const [provider, setProvider] = useState("clawhub");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const operationBusy = useRef(false);
  const [error, setError] = useState<{ tab: string; provider: string; detail: string; retry: () => void }>();
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
  const enabledCount =
    bindings.error || workspaces.error ? undefined : bindings.value?.items.filter((binding) => binding.enabled).length;
  const refresh = () => setNonce((value) => value + 1);
  const workspaceName = workspaces.value?.items.find((item) => item.id === workspaceId)?.name ?? "";
  const discover = (source = "clawhub") => {
    setProvider(source);
    setTab("discover");
  };
  const act = async (operation: () => Promise<void>) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      setNonce((value) => value + 1);
    } catch (cause) {
      setError({ tab, provider, detail: message(cause), retry: () => void act(operation) });
    } finally {
      operationBusy.current = false;
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
              <button className="capability-refresh" onClick={refresh}>
                <Icon name="refresh" />
                刷新
              </button>
              {tab !== "discover" && (
                <button className="primary" onClick={() => discover()}>
                  <Icon name="plus" />
                  发现能力
                </button>
              )}
            </div>
          }
        />
      </div>
      <dl className="capability-summary" aria-label="能力概览">
        <div>
          <dt>已安装版本</dt>
          <dd>{installed.value && !installed.error ? items.length : "—"}</dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>{installed.value && !installed.error ? items.filter((item) => item.kind === "skill").length : "—"}</dd>
        </div>
        <div>
          <dt>MCP 服务</dt>
          <dd>{installed.value && !installed.error ? items.filter((item) => item.kind === "mcp").length : "—"}</dd>
        </div>
        <div title={workspaceName ? `工作区：${workspaceName}` : "暂无工作区"}>
          <dt>当前工作区已启用</dt>
          <dd>{enabledCount ?? "—"}</dd>
        </div>
      </dl>
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
        {tab !== "discover" && error?.tab === tab && (
          <CapabilityStatus
            error={error.detail}
            title="本次操作未完成"
            impact="操作尚未完成，请处理以下问题后重试"
            retry={error.retry}
          />
        )}
        {tab === "discover" && (
          <Discover
            client={client}
            busy={busy}
            provider={provider}
            onProviderChange={(source) => {
              setError(undefined);
              setProvider(source);
            }}
            refreshRevision={revision + nonce}
            installations={items}
            bindings={bindings.value?.items ?? []}
            installationsKnown={!!installed.value && !installed.error}
            bindingsKnown={!!bindings.value && !bindings.error && !workspaces.error}
            stateError={installed.error || workspaces.error || bindings.error}
            onRefreshState={refresh}
            workspaceName={workspaceName}
            operationError={error?.tab === "discover" && error.provider === provider ? error : undefined}
            onDismissError={() => setError(undefined)}
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
            <CapabilityStatus
              error={installed.error || workspaces.error || bindings.error}
              title="安装与启用状态暂不可用"
              impact="暂时无法读取已安装版本或工作区启用状态"
              retry={refresh}
            />
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
            ) : installed.error && !installed.value ? null : !items.length ? (
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
            <CapabilityStatus
              error={updates.error}
              title="更新记录暂不可用"
              impact="暂时无法读取最近的版本检查结果"
              retry={updates.reload}
            />
            {updates.loading && !updates.value ? (
              <Loading />
            ) : updates.error && !updates.value ? null : updates.value?.items.length ? (
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
            <CapabilityStatus
              error={connections.error}
              title="连接状态暂不可用"
              impact="暂时无法读取 MCP 服务的连接与工具状态"
              retry={connections.reload}
            />
            {connections.loading && !connections.value ? (
              <Loading />
            ) : connections.error && !connections.value ? null : connections.value?.items.length ? (
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
                  <CapabilityStatus
                    error={connection.error}
                    title="此 MCP 服务暂不可用"
                    impact="此服务的工具暂时无法使用，其他能力不受影响"
                    retry={() =>
                      void act(async () => {
                        await client.reconnectMcp(connection.installId);
                        toast.success("连接与工具定义已重新发现");
                      })
                    }
                  />
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
                  {!connection.error && (
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
                  )}
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
  refreshRevision,
  installations,
  bindings,
  installationsKnown,
  bindingsKnown,
  stateError,
  onRefreshState,
  workspaceName,
  operationError,
  onDismissError,
  onInstall
}: {
  client: RuntimeAdminClient;
  busy: boolean;
  provider: string;
  onProviderChange: (provider: string) => void;
  refreshRevision: number;
  installations: readonly CapabilityInfo[];
  bindings: readonly CapabilityBinding[];
  installationsKnown: boolean;
  bindingsKnown: boolean;
  stateError: string;
  onRefreshState: () => void;
  workspaceName: string;
  operationError: { detail: string; retry: () => void } | undefined;
  onDismissError: () => void;
  onInstall: (input: unknown) => Promise<void>;
}) {
  const searchId = useId();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState<string>();
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<CatalogItem>();
  const source = catalogSources.find((item) => item.id === provider)!;
  const results = useLoad(
    useCallback(
      () =>
        query !== undefined && provider !== "github"
          ? client.searchCatalog(provider, query)
          : Promise.resolve(undefined),
      [client, provider, query]
    ),
    refreshRevision
  );
  const activeFilter =
    !installationsKnown || (filter === "enabled" && (!bindingsKnown || !workspaceName)) ? "all" : filter;
  const visibleItems = (results.value?.items ?? []).filter((item) => {
    const state = catalogItemState(item, installations, bindings);
    if (activeFilter === "enabled") return state === "enabled";
    if (activeFilter === "installed") return state !== "uninstalled";
    if (activeFilter === "uninstalled") return state === "uninstalled";
    return true;
  });
  const search = (value: string) => {
    const keyword = value.trim();
    if (!keyword) return;
    onDismissError();
    setQ(keyword);
    setSelected(undefined);
    if (query === keyword) results.reload();
    setQuery(keyword);
  };
  return (
    <div className="capability-discovery">
      <section className="capability-discovery-tools" aria-label="发现与搜索能力">
        <div className="capability-source-label">
          <h2>选择发现来源</h2>
          <span>先选择来源，再搜索或填写安装信息</span>
        </div>
        <CatalogSources
          selected={provider}
          onSelect={(source) => {
            if (source === provider) return;
            // 来源与搜索上下文在同一事件中切换，避免旧关键词或结果被解释为新来源的数据
            setQ("");
            setQuery(undefined);
            setFilter("all");
            setSelected(undefined);
            onProviderChange(source);
          }}
          disabled={busy}
          sourceStatus={
            results.error
              ? "搜索暂不可用"
              : operationError?.detail.includes("mcp_host_requires_configuration")
                ? "需配置主机"
                : undefined
          }
        />
        {provider !== "github" && (
          <>
            <label className="capability-search-label" htmlFor={searchId}>
              在 {source.description} 中搜索
            </label>
            <form
              className="capability-search"
              onSubmit={(event) => {
                event.preventDefault();
                search(q);
              }}
            >
              <Icon name="search" />
              <input
                id={searchId}
                aria-label={`搜索 ${source.name}`}
                placeholder={
                  provider === "clawhub" ? "输入技能名称或关键词，例如 github" : "输入 MCP 服务名称或关键词，例如 files"
                }
                maxLength={500}
                value={q}
                onChange={(event) => setQ(event.target.value)}
              />
              <button className="primary" disabled={!q.trim() || (results.loading && query !== undefined)}>
                <Icon name="search" />
                搜索能力
              </button>
            </form>
          </>
        )}
      </section>
      {provider === "github" ? (
        <GitHubInstall
          busy={busy}
          operationError={operationError}
          onDismissError={onDismissError}
          onInstall={onInstall}
        />
      ) : (
        <div className={`capability-layout ${selected ? "" : "is-browsing"}`}>
          <section className="panel capability-list capability-results" aria-label="目录搜索结果">
            <div className="capability-results-heading">
              <div>
                <h2>搜索结果</h2>
                <p>{query !== undefined ? `${source.description} · “${query}”` : "输入关键词，发现适合工作区的能力"}</p>
              </div>
              {query !== undefined && !results.loading && !results.error && (
                <span>
                  {visibleItems.length} / {results.value?.items.length ?? 0} 项
                </span>
              )}
            </div>
            <div className="capability-result-filters" role="group" aria-label="筛选当前搜索结果">
              {(
                [
                  ["all", "全部"],
                  ["installed", "已安装"],
                  ["uninstalled", "未安装"],
                  ["enabled", "已启用"]
                ] as const
              ).map(([key, label]) => {
                const unavailable =
                  key !== "all" && (!installationsKnown || (key === "enabled" && (!bindingsKnown || !workspaceName)));
                return (
                  <button
                    key={key}
                    aria-pressed={activeFilter === key}
                    disabled={unavailable}
                    title={
                      unavailable
                        ? "读取安装与工作区状态后可筛选"
                        : key === "enabled"
                          ? `工作区：${workspaceName}`
                          : undefined
                    }
                    onClick={() => {
                      setFilter(key);
                      setSelected(undefined);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
              <span>{workspaceName ? `工作区：${workspaceName}` : "暂无工作区"}</span>
            </div>
            {stateError && (
              <details className="capability-state-note">
                <summary>安装与启用状态暂不可用，目录仍可搜索</summary>
                <CapabilityStatus
                  error={stateError}
                  title="无法核对安装与启用状态"
                  impact="相关筛选暂不可用，目录搜索不受影响"
                  retry={onRefreshState}
                />
              </details>
            )}
            <div
              className="capability-results-body"
              aria-live="polite"
              aria-busy={query !== undefined && results.loading}
            >
              {query === undefined ? (
                <CapabilityEmpty
                  icon="search"
                  title={q.trim() ? "关键词已就绪，点击搜索开始发现" : "输入关键词，开始发现能力"}
                  text={`搜索范围为 ${source.description}。选择结果后可查看版本、来源与安装状态`}
                  action={
                    <div className="capability-search-suggestions">
                      <span>试试搜索</span>
                      {["github", "web", "files"].map((keyword) => (
                        <button key={keyword} onClick={() => search(keyword)}>
                          {keyword}
                        </button>
                      ))}
                    </div>
                  }
                />
              ) : results.loading ? (
                <Loading />
              ) : results.error ? (
                <CapabilityStatus
                  error={results.error}
                  title={`${source.description} 搜索暂不可用`}
                  impact="当前来源的搜索未完成，你可以重试或切换其他来源"
                  retry={results.reload}
                />
              ) : visibleItems.length ? (
                visibleItems.map((item) => {
                  const state = catalogItemState(item, installations, bindings);
                  return (
                    <button
                      className={`capability-row ${selected?.packageId === item.packageId ? "selected" : ""}`}
                      aria-pressed={selected?.packageId === item.packageId}
                      key={item.packageId}
                      onClick={() => {
                        onDismissError();
                        setSelected(item);
                      }}
                    >
                      <CapabilityKind skill={item.provider === "clawhub"} />
                      <span className="capability-row-body">
                        <strong>{item.name}</strong>
                        <small>{item.description.slice(0, 180)}</small>
                        <small>{item.packageId}</small>
                        <span
                          className={`capability-state ${installationsKnown && bindingsKnown && state === "enabled" ? "is-enabled" : ""}`}
                        >
                          {!installationsKnown
                            ? "安装状态未读取"
                            : bindingsKnown && state === "enabled"
                              ? "当前工作区已启用"
                              : state !== "uninstalled"
                                ? "已安装"
                                : "未安装"}
                        </span>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  );
                })
              ) : (
                <CapabilityEmpty
                  icon="search"
                  title={results.value?.items.length ? "当前筛选下没有匹配能力" : "没有找到匹配能力"}
                  text={
                    results.value?.items.length
                      ? "筛选仅作用于本次搜索结果，可以查看全部或更换关键词"
                      : `没有找到与“${query}”匹配的结果，请尝试其他关键词或切换来源`
                  }
                  action={
                    <button
                      onClick={() => {
                        setFilter("all");
                        if (!results.value?.items.length) document.getElementById(searchId)?.focus();
                      }}
                    >
                      {results.value?.items.length ? "查看全部结果" : "修改关键词"}
                    </button>
                  }
                />
              )}
            </div>
          </section>
          {selected && (
            <CatalogDetail
              key={`${selected.provider}:${selected.packageId}`}
              client={client}
              item={selected}
              busy={busy}
              refreshRevision={refreshRevision}
              installations={installations}
              operationError={operationError}
              onDismissError={onDismissError}
              onInstall={onInstall}
            />
          )}
        </div>
      )}
    </div>
  );
}

function GitHubInstall({
  busy,
  operationError,
  onDismissError,
  onInstall
}: {
  busy: boolean;
  operationError: { detail: string; retry: () => void } | undefined;
  onDismissError: () => void;
  onInstall: (input: unknown) => Promise<void>;
}) {
  const [repository, setRepository] = useState("");
  const [revision, setRevision] = useState("");
  const [directory, setDirectory] = useState("");
  return (
    <form
      className="panel capability-panel capability-github-form"
      onChange={onDismissError}
      onSubmit={(event) => {
        event.preventDefault();
        void onInstall({
          provider: "github",
          packageId: repository.trim(),
          revision,
          ...(directory.trim() ? { directory: directory.trim() } : {})
        });
      }}
    >
      <div className="capability-detail-heading">
        <span className="capability-kind">
          <Icon name="branch" />
        </span>
        <div>
          <h2>从 GitHub 仓库安装</h2>
          <p>填写仓库和固定提交，安装一个可审阅的 Skill 快照</p>
        </div>
      </div>
      <label>
        GitHub 仓库
        <input
          aria-label="GitHub 仓库"
          required
          pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
          placeholder="owner/repository"
          maxLength={500}
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
        />
      </label>
      <div className="capability-github-fields">
        <label>
          完整 Commit SHA
          <input
            aria-label="完整 Commit SHA"
            required
            pattern="[a-f0-9]{40}"
            placeholder="40 位提交 SHA"
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
          />
        </label>
        <label>
          Skill 目录（可选）
          <input
            aria-label="Skill 子目录"
            placeholder="例如 skills/report-analysis"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
        </label>
      </div>
      <p>GitHub 来源按指定仓库安装，不提供关键词搜索。仅保存标准 SKILL.md 目录与资源，脚本不会执行</p>
      {operationError && (
        <CapabilityStatus
          error={operationError.detail}
          title="GitHub 快照安装未完成"
          impact="请处理以下问题后重试，并在“已安装”中确认安装结果"
          retry={operationError.retry}
        />
      )}
      <div className="capability-install-footer">
        <span>安装后，在“已安装”中为工作区启用</span>
        <button
          className="primary"
          disabled={
            busy || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim()) || !/^[a-f0-9]{40}$/.test(revision)
          }
        >
          <Icon name="plus" />
          {busy ? "安装中…" : "安装固定快照"}
        </button>
      </div>
    </form>
  );
}

function CatalogDetail({
  client,
  item,
  busy,
  refreshRevision,
  installations,
  operationError,
  onDismissError,
  onInstall
}: {
  client: RuntimeAdminClient;
  item: CatalogItem;
  busy: boolean;
  refreshRevision: number;
  installations: readonly CapabilityInfo[];
  operationError: { detail: string; retry: () => void } | undefined;
  onDismissError: () => void;
  onInstall: (input: unknown) => Promise<void>;
}) {
  const [version, setVersion] = useState("");
  const [endpoint, setEndpoint] = useState(0);
  const versions = useLoad(
    useCallback(() => client.catalogVersions(item.provider, item.packageId), [client, item.provider, item.packageId]),
    refreshRevision
  );
  const remotes = item.remotes?.filter((remote) => remote.type === "streamable-http") ?? [];
  const alreadyInstalled = installations.some(
    (installation) =>
      installation.packageKey === `${item.provider}:${item.packageId}` && installation.sourceVersion === version
  );
  return (
    <section className="panel capability-panel">
      <div className="capability-detail-heading">
        <CapabilityKind skill={item.provider === "clawhub"} />
        <div>
          <span className="capability-eyebrow">{item.provider === "clawhub" ? "SKILL" : "MCP SERVICE"}</span>
          <h2>{item.name}</h2>
        </div>
      </div>
      <p>{item.description}</p>
      <dl className="capability-facts">
        <dt>来源</dt>
        <dd>
          {item.provider} · {item.packageId}
        </dd>
        <dt>作者</dt>
        <dd>{item.author ?? "查看来源目录"}</dd>
        <dt>许可证</dt>
        <dd>{item.license ?? "安装后审阅包内许可证"}</dd>
      </dl>
      {safeLink(item.url) && (
        <a href={safeLink(item.url)} rel="noreferrer" target="_blank">
          查看来源
          <Icon name="arrowRight" />
        </a>
      )}
      <CapabilityStatus
        error={versions.error}
        title="版本列表暂不可用"
        impact="请重新读取发布版本，再选择要安装的版本"
        retry={versions.reload}
      />
      <label>
        选择安装版本
        <select
          aria-label="安装版本"
          value={version}
          disabled={versions.loading || !!versions.error}
          onChange={(event) => {
            onDismissError();
            setVersion(event.target.value);
          }}
        >
          <option value="">{versions.loading ? "正在读取版本…" : "选择精确发布版本"}</option>
          {versions.value?.items.map((entry) => (
            <option key={entry.version} value={entry.version}>
              {entry.version}
            </option>
          ))}
        </select>
      </label>
      {versions.value && !versions.loading && !versions.value.items.length && <p>此来源暂未提供可安装的发布版本</p>}
      {versions.value?.items.find((entry) => entry.version === version)?.changelog && (
        <pre>{versions.value.items.find((entry) => entry.version === version)!.changelog}</pre>
      )}
      {item.provider === "mcp-official" && (
        <label>
          远程 HTTP 端点
          <select
            aria-label="MCP 端点"
            value={endpoint}
            disabled={!remotes.length}
            onChange={(event) => {
              onDismissError();
              setEndpoint(Number(event.target.value));
            }}
          >
            {!remotes.length && <option value="0">此服务未提供可安装的 HTTP 端点</option>}
            {remotes.map((remote, index) => (
              <option key={remote.url} value={index}>
                {remote.url}
              </option>
            ))}
          </select>
        </label>
      )}
      {operationError && (
        <CapabilityStatus
          error={operationError.detail}
          title="此版本安装未完成"
          impact="请处理以下问题后重试，并在“已安装”中确认安装结果"
          retry={operationError.retry}
        />
      )}
      <div className="capability-install-footer">
        <span>安装后，在“已安装”中为工作区启用</span>
        <button
          className="primary"
          disabled={
            busy ||
            !version ||
            versions.loading ||
            !!versions.error ||
            alreadyInstalled ||
            (item.provider === "mcp-official" && !remotes.length)
          }
          onClick={() =>
            void onInstall({
              provider: item.provider,
              packageId: item.packageId,
              version,
              ...(item.provider === "mcp-official" ? { endpointIndex: endpoint } : {})
            })
          }
        >
          <Icon name={alreadyInstalled ? "check" : "plus"} />
          {busy ? "安装中…" : alreadyInstalled ? "此版本已安装" : "安装此版本"}
        </button>
      </div>
    </section>
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
          <CapabilityStatus
            error={resource.error}
            title="文件暂时无法读取"
            impact="请重试读取所选 Skill 文件，其他安装信息仍可查看"
            retry={resource.reload}
          />
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

function CatalogSources({
  selected,
  onSelect,
  disabled,
  sourceStatus
}: {
  selected: string;
  onSelect: (provider: string) => void;
  disabled: boolean;
  sourceStatus?: string | undefined;
}) {
  return (
    <div className="capability-sources" role="group" aria-label="选择发现来源">
      {catalogSources.map((source) => (
        <button
          key={source.id}
          className={`capability-source ${selected === source.id ? "selected" : ""}`}
          aria-pressed={selected === source.id}
          disabled={disabled}
          onClick={() => onSelect(source.id)}
        >
          <span className={`capability-kind source-${source.id}`}>
            <Icon name={source.icon} />
          </span>
          <span className="capability-source-text">
            <strong>{source.name}</strong>
            <span className={sourceStatus && selected === source.id ? "capability-source-warning" : ""}>
              {sourceStatus && selected === source.id ? sourceStatus : source.label}
            </span>
          </span>
          <span className="capability-source-check">{selected === source.id && <Icon name="check" />}</span>
        </button>
      ))}
    </div>
  );
}

function CapabilityStatus({
  error,
  title,
  impact,
  retry
}: {
  error?: string | undefined;
  title: string;
  impact: string;
  retry: () => void;
}) {
  if (!error) return null;
  const issue = capabilityIssue(error);
  return (
    <section className="capability-status" role="status">
      <span className="capability-status-icon">
        <Icon name="settings" />
      </span>
      <div className="capability-status-content">
        <h3>{issue.title || title}</h3>
        <p>{impact}</p>
        <p>{issue.reason}</p>
        <div className="capability-status-actions">
          <a className="button" href={`#/system?section=${issue.section}`}>
            去配置
            <Icon name="arrowRight" />
          </a>
          <button onClick={retry}>
            <Icon name="refresh" />
            重试
          </button>
          <details>
            <summary>查看详情</summary>
            <pre>{error}</pre>
          </details>
        </div>
      </div>
    </section>
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

import type { ConversationStore } from "../conversation/index.js";
import type { ContextGraph } from "../context-graph/index.js";
import type { ListRunsInput, RunTraceStore } from "../trace/types.js";

/** 查询所需的只读持久能力，SQL、连接和写入生命周期由 App 注入 */
export interface InspectionStore {
  readonly runs: Pick<RunTraceStore, "get" | "list" | "events" | "latestEvent" | "stream" | "highWaterMark">;
  readonly contextGraph: Pick<ContextGraph, "getCommit">;
  readonly getSession: ConversationStore["getSession"];
  /** 对历史内容应用部署凭据脱敏规则 */
  inspectValue(value: unknown): unknown;
  /** 返回有界会话元数据 */
  inspectSessions(limit: number, before: number): readonly unknown[];
  /** 返回会话内公开消息 */
  inspectTranscript(sessionId: string, limit: number, before: number): readonly unknown[];
  /** 返回会话内按名称排序的引用 */
  inspectRefs(sessionId: string, limit: number, after: string): readonly unknown[];
}

/** 下载内容只在宿主响应边界使用，不进入查询脱敏或事件流 */
export interface InspectedArtifactContent {
  readonly name: string;
  readonly size: number;
  readonly data: Uint8Array;
}

/** 工件读取端口，实现负责会话归属、文件完整性和存储限额 */
export interface ArtifactReader {
  /** 有界列举指定会话的元数据 */
  list(
    sessionId: string,
    after: string,
    limit: number
  ): { readonly items: readonly unknown[]; readonly nextCursor?: string };
  /** 读取并校验指定会话的工件元数据 */
  describe(sessionId: string, id: string): unknown;
  /** 读取并校验工件字节 */
  read(sessionId: string, id: string): InspectedArtifactContent;
}

/** 查询条件无效，宿主可映射稳定错误而不暴露存储异常 */
export class InspectionQueryError extends Error {}

/** Runtime 查询用例，集中维护分页、作用域、快照和脱敏边界 */
export class RuntimeInspection {
  /** 注入只读端口，不拥有底层资源生命周期 */
  constructor(
    private readonly store: InspectionStore,
    private readonly artifacts: ArtifactReader
  ) {}

  /** 查询已脱敏的运行投影 */
  getRun(id: string) {
    return this.store.runs.get(id);
  }

  /** 校验有界条件后按稳定游标读取运行列表 */
  listRuns(query: ListRunsInput = {}) {
    page(query.limit ?? 50, query.before ?? Number.MAX_SAFE_INTEGER);
    if (
      query.status !== undefined &&
      !["accepted", "running", "succeeded", "failed", "blocked", "uncertain", "interrupted"].includes(query.status)
    )
      throw new InspectionQueryError();
    for (const value of [query.since, query.until])
      if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new InspectionQueryError();
    if (query.since && query.until && Date.parse(query.since) > Date.parse(query.until))
      throw new InspectionQueryError();
    return this.store.runs.list(query);
  }

  /** 单次运行的增量及分页边界由同一份运行投影决定 */
  getRunEvents(id: string, afterSeq = 0, limit = 100) {
    page(limit, afterSeq);
    const run = this.getRun(id);
    if (!run) return undefined;
    const events = this.store.runs.events(id, afterSeq, limit);
    const nextSeq = events.at(-1)?.seq ?? afterSeq;
    return { events, nextSeq, hasMore: nextSeq < run.lastSeq };
  }

  /** 查询持久上下文快照，不重新构建历史事实 */
  getRunContext(id: string) {
    if (!this.getRun(id)) return undefined;
    const snapshot = this.store.runs.latestEvent(id, "context_resolved");
    return { available: snapshot !== undefined, snapshot: snapshot?.data ?? null, eventId: snapshot?.id ?? null };
  }

  /** 读取会话并脱敏，保留不存在的语义 */
  async getSession(id: string) {
    const session = await this.store.getSession(id);
    return session === undefined ? undefined : this.store.inspectValue(session);
  }

  /** 会话列表沿用创建顺序游标 */
  listSessions(limit = 50, before = Number.MAX_SAFE_INTEGER) {
    page(limit, before);
    const items = this.store.inspectSessions(limit, before);
    return {
      items,
      nextCursor: items.length === limit ? ((items.at(-1) as { cursor?: number } | undefined)?.cursor ?? null) : null
    };
  }

  /** 只在目标会话存在时读取消息分页 */
  async getTranscript(sessionId: string, limit = 50, before = Number.MAX_SAFE_INTEGER) {
    page(limit, before);
    if (!(await this.store.getSession(sessionId))) return undefined;
    const items = this.store.inspectTranscript(sessionId, limit, before);
    return { items, nextCursor: (items.at(-1) as { cursor?: number } | undefined)?.cursor ?? null };
  }

  /** 引用按会话作用域与名称游标查询 */
  async getRefs(sessionId: string, limit = 50, after = "") {
    page(limit, 0);
    if (!(await this.store.getSession(sessionId))) return undefined;
    const items = this.store.inspectRefs(sessionId, limit, after);
    return { items, nextCursor: (items.at(-1) as { name?: string } | undefined)?.name ?? null };
  }

  /** 提交身份始终与会话作用域一起校验 */
  getCommit(sessionId: string, id: string) {
    const commit = this.store.contextGraph.getCommit(sessionId, id);
    return commit === undefined ? undefined : this.store.inspectValue(commit);
  }

  /** 单次返回有界多父子图，截断边界保留缺失父标识供客户端继续回溯 */
  async getSessionGraph(sessionId: string, head?: string, limit = 200) {
    page(limit, 0);
    if (!(await this.store.getSession(sessionId))) return undefined;
    const refs = this.store.inspectRefs(sessionId, 200, "") as readonly {
      name: string;
      commitId: string;
      version: number;
    }[];
    if (head && !this.store.contextGraph.getCommit(sessionId, head)) return undefined;
    const pending = head ? [head] : refs.map((ref) => ref.commitId);
    const visited = new Set<string>();
    const commits = [];
    while (pending.length && commits.length < limit) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const commit = this.store.contextGraph.getCommit(sessionId, id);
      if (!commit) continue;
      commits.push(commit);
      pending.push(...commit.parents);
    }
    const nodes = commits.map((commit) => this.store.inspectValue(commit));
    const ids = new Set(commits.map((commit) => commit.id));
    const boundary = [...new Set(pending.filter((id) => !ids.has(id)))];
    return {
      nodes,
      edges: commits.flatMap((commit) => commit.parents.map((parent) => ({ source: parent, target: commit.id }))),
      refs,
      truncated: boundary.length > 0 || refs.length === 200,
      boundary
    };
  }

  /** 工件列表只返回目标会话数据，不加载二进制内容 */
  async listArtifacts(sessionId: string, after = "", limit = 50) {
    page(limit, 0);
    if (!(await this.store.getSession(sessionId))) return undefined;
    return this.artifacts.list(sessionId, after, limit);
  }

  /** 未知、越权和损坏工件均不暴露存储细节 */
  getArtifact(sessionId: string, id: string) {
    try {
      return this.store.inspectValue(this.artifacts.describe(sessionId, id));
    } catch {
      return undefined;
    }
  }

  /** 下载前校验归属和摘要，保持二进制内容原样 */
  readArtifact(sessionId: string, id: string) {
    try {
      return this.artifacts.read(sessionId, id);
    } catch {
      return undefined;
    }
  }

  /** 同步获取流快照，避免快照和游标之间插入异步调度 */
  streamSnapshot(after?: number) {
    const highWaterMark = this.store.runs.highWaterMark();
    const cursor = after ?? highWaterMark;
    page(1, cursor);
    return { cursor, highWaterMark, runs: this.listRuns().items };
  }

  /** 读取有界持久增量，连接、背压和心跳由宿主负责 */
  streamEvents(after: number, limit = 200) {
    page(limit, after);
    return this.store.runs.stream(after, limit);
  }
}

function page(limit: number, cursor: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new InspectionQueryError();
}

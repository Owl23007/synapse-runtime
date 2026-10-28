import { createHash } from "node:crypto";
import type { ConversationStore } from "../conversation/store.js";
import type { ContextGraph } from "../context-graph/index.js";
import type { RunTraceStore } from "../trace/types.js";
import type { RuntimeCore } from "./runtime-core.js";

/** 工作台依赖领域存储端口，具体数据库由应用层装配 */
export interface RuntimeWorkspaceStore extends ConversationStore {
  readonly contextGraph: ContextGraph;
  readonly runs: Pick<RunTraceStore, "list">;
  /** 对返回浏览器的历史内容脱敏 */
  inspectValue(value: unknown): unknown;
}

/** 可在宿主传输边界映射的工作台操作错误 */
export class WorkspaceOperationError extends Error {
  /** 保留查询、归属和并发冲突语义 */
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** 协调会话、历史分叉和结果发布，执行由 RuntimeCore 承担 */
export class RuntimeWorkspace {
  /** 注入当前运行组合的领域能力，不拥有资源生命周期 */
  constructor(
    private readonly runtime: RuntimeCore,
    private readonly contextStore: RuntimeWorkspaceStore
  ) {}
  /** 创建带主线引用的持久原生会话 */
  async createSession(input: unknown) {
    const { contextStore } = this;
    const body = object(input);
    const key = string(body.idempotencyKey, 200);
    const id = `native-${digest(key)}`;
    const existing = await contextStore.getSession(id);
    const title = string(body.title, 120);
    if (existing && (existing.metadata as { title?: string } | undefined)?.title !== title)
      throw new WorkspaceOperationError(409, "幂等键对应的会话名称不同");
    const session =
      existing ??
      (await contextStore.createSession({
        id,
        locator: {
          platform: "native",
          provider: "native",
          channelId: "native",
          conversationType: "private",
          conversationId: id
        },
        metadata: { title },
        idempotencyKey: key
      }));
    contextStore.contextGraph.commit({
      scopeId: id,
      refName: `line:${session.mainlineId}`,
      expectedVersion: null,
      idempotencyKey: `session:${id}:root`,
      type: "session",
      content: { title, lineId: session.mainlineId }
    });
    return { session: contextStore.inspectValue(session) };
  }

  /** 接收原生输入并返回持久运行身份 */
  async submitRun(input: unknown) {
    const { runtime } = this;
    const body = object(input);
    const run = await runtime.submitNative({
      sessionId: string(body.sessionId),
      text: string(body.text, 32000),
      idempotencyKey: string(body.idempotencyKey, 200),
      ...(body.lineId === undefined ? {} : { lineId: string(body.lineId) })
    });
    return { run };
  }

  /** 按会话线返回有界消息、分支和历史游标 */
  async getWorkspace(sessionId: string, lineIdQuery?: string, beforeQuery?: string) {
    const { contextStore } = this;
    const session = await contextStore.getSession(sessionId);
    if (!session) throw new WorkspaceOperationError(404, "会话不存在");
    const lineId = lineIdQuery ?? session.mainlineId;
    const line = await contextStore.getLine(lineId);
    if (!line || line.sessionId !== session.id) throw new WorkspaceOperationError(404, "会话线不存在");
    const before = beforeQuery ?? null;
    if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))))
      throw new WorkspaceOperationError(400, "消息游标无效");
    const events = await contextStore.listEvents(lineId, {
      types: ["user_message", "assistant_message", "branch_result"],
      ...(before === null ? {} : { beforeSequence: Number(before) }),
      limit: 100
    });
    const branches = await contextStore.listBranches(session.id);
    return contextStore.inspectValue({
      session,
      line,
      branches,
      messages: events,
      nextCursor: events[0]?.sequence ?? 0,
      hasMore: events.length === 100
    });
  }

  /** 从历史上下文提交建立隔离会话线 */
  async fork(sessionId: string, input: unknown) {
    const { runtime, contextStore } = this;
    const session = await contextStore.getSession(sessionId);
    if (!session || session.locator?.platform !== "native") throw new WorkspaceOperationError(404, "原生会话不存在");
    const body = object(input);
    const commitId = string(body.commitId);
    const commit = contextStore.contextGraph.getCommit(sessionId, commitId);
    if (!commit) throw new WorkspaceOperationError(404, "提交不属于此会话");
    const key = string(body.idempotencyKey, 200);
    const title = string(body.title, 120);
    // 分支契约要求主线事件作为锚点；commitId 独立保存，绝不混用两种节点身份
    const anchor = await contextStore.appendEvent(session.mainlineId, {
      type: "history_fork",
      idempotencyKey: `fork:${key}`,
      payload: { commitId }
    });
    const branch = await runtime.createBranch({
      id: `branch-${digest(`${sessionId}:${key}`)}`,
      sessionId,
      sourceEventId: anchor.id,
      title,
      goal: title,
      reason: "从历史上下文继续",
      createdBy: "runtime-admin",
      idempotencyKey: key,
      contextSnapshot: { contextCommitId: commitId }
    });
    // 重试已使用的分支时保留当前头，只有尚未落盘的引用需要补齐
    if (!contextStore.contextGraph.getRef(sessionId, `line:${branch.id}`))
      contextStore.contextGraph.fork(sessionId, `line:${branch.id}`, commitId);
    return { branch };
  }

  /** 检查主线版本与来源头后显式发布分支结果 */
  async merge(sessionId: string, input: unknown) {
    const { contextStore } = this;
    const session = await contextStore.getSession(sessionId);
    if (!session || session.locator?.platform !== "native") throw new WorkspaceOperationError(404, "原生会话不存在");
    const body = object(input);
    const branch = await contextStore.getBranch(string(body.branchId));
    if (!branch || branch.sessionId !== sessionId) throw new WorkspaceOperationError(404, "分支不存在");
    const source = contextStore.contextGraph.getRef(sessionId, `line:${branch.id}`);
    const target = contextStore.contextGraph.getRef(sessionId, `line:${session.mainlineId}`);
    const key = string(body.idempotencyKey, 200);
    const prior = contextStore.contextGraph.getCommitByKey(sessionId, `merge:${key}`);
    const publish = async (summary: string) => {
      const result = await contextStore.createBranchResult(branch.id, {
        status: "completed",
        summary,
        idempotencyKey: `native-merge:${key}:result`
      });
      await contextStore.publishBranchResult(branch.id, session.mainlineId, {
        resultId: result.id,
        idempotencyKey: `native-merge:${key}:publish`
      });
    };
    if (prior) {
      if (prior.content.branchId !== branch.id || !prior.parents.includes(String(body.sourceCommitId)))
        throw new WorkspaceOperationError(409, "幂等键对应的合并请求不同");
      await publish(String(prior.content.summary));
      return { commit: contextStore.inspectValue(prior) };
    }
    if (!source || !target || target.version !== body.expectedVersion || source.commitId !== body.sourceCommitId)
      throw new WorkspaceOperationError(409, "上下文已更新，请刷新后重新比较");
    const runs = contextStore.runs.list({ sessionId, limit: 200 }).items;
    if (runs.find((run) => run.lineId === branch.id)?.status !== "succeeded")
      throw new WorkspaceOperationError(409, "分支需要有成功的运行结果才能合并");
    if (
      runs.some(
        (run) =>
          ["accepted", "running"].includes(run.status) && [branch.id, session.mainlineId].includes(run.lineId ?? "")
      )
    )
      throw new WorkspaceOperationError(409, "请等待主线与分支运行结束后合并");
    const commit = contextStore.contextGraph.getCommit(sessionId, source.commitId)!;
    const summary =
      typeof commit.content.summary === "string"
        ? commit.content.summary
        : typeof commit.content.output === "string"
          ? commit.content.output
          : "";
    if (!summary || source.commitId === object(branch.contextSnapshot).contextCommitId)
      throw new WorkspaceOperationError(409, "分支尚无可合并的运行结果");
    const merged = contextStore.contextGraph.merge({
      scopeId: sessionId,
      refName: target.name,
      expectedVersion: target.version,
      additionalParents: [source.commitId],
      idempotencyKey: `merge:${key}`,
      type: "merge",
      content: { summary, branchId: branch.id },
      metadata: { sourceVersion: source.version }
    });
    // 图与结构化结果使用同一操作键，跨投影中断后由相同请求补齐，不再次移动引用
    await publish(summary);
    return { commit: contextStore.inspectValue(merged) };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspaceOperationError(400, "请求格式无效");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new WorkspaceOperationError(400, "必填字段为空或超出长度限制");
  return value.trim();
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

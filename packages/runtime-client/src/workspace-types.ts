/** 工作区会话元数据，频道会话可只读打开 */
export interface WorkspaceSession {
  readonly id: string;
  readonly mainlineId: string;
  readonly status: string;
  readonly locator?: { readonly platform: string };
  readonly metadata?: { readonly title?: string };
}

/** 可选择的隔离会话分支 */
export interface WorkspaceBranch {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly contextSnapshot?: { readonly contextCommitId?: string };
}

/** 持久消息保留会话线事件标识，关联上下文图时不混用提交标识 */
export interface WorkspaceMessage {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly createdAt: string;
  readonly payload: { readonly text?: string; readonly summary?: string; readonly message?: unknown };
}

/** 单页会话工作区投影 */
export interface WorkspaceView {
  readonly session: WorkspaceSession;
  readonly line: { readonly id: string; readonly kind: string };
  readonly branches: readonly WorkspaceBranch[];
  readonly messages: readonly WorkspaceMessage[];
  readonly hasMore: boolean;
  readonly nextCursor: number;
}

/** 不可变上下文节点，运行状态由独立运行投影提供 */
export interface GraphCommit {
  readonly id: string;
  readonly parents: readonly string[];
  readonly type: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/** 会话引用版本用于乐观并发检查 */
export interface GraphRef {
  readonly name: string;
  readonly commitId: string;
  readonly version: number;
}

/** 一次查询返回有界子图和继续回溯的边界 */
export interface SessionGraphView {
  readonly nodes: readonly GraphCommit[];
  readonly edges: readonly { readonly source: string; readonly target: string }[];
  readonly refs: readonly GraphRef[];
  readonly truncated: boolean;
  readonly boundary: readonly string[];
}

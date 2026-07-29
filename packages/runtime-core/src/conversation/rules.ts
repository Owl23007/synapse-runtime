import { ConversationStoreError } from "./errors.js";
import type {
  BranchResult,
  BranchStatus,
  ConversationBranch,
  ConversationSession,
  SessionStatus,
  TaskStatus
} from "./types.js";

export const ACTIVE_BRANCH_STATUSES: ReadonlySet<BranchStatus> = new Set([
  "created",
  "active",
  "blocked",
  "inactive",
  "completed"
]);

export const UNFINISHED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "running", "blocked"]);

export const BRANCH_STATUSES_REQUIRING_TERMINAL_TASKS: ReadonlySet<BranchStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "archived"
]);

export const SESSION_ARCHIVABLE_BRANCH_STATUSES: ReadonlySet<BranchStatus> = new Set([
  "merged",
  "failed",
  "cancelled",
  "archived"
]);

const BRANCH_TRANSITIONS: Readonly<Record<BranchStatus, ReadonlySet<BranchStatus>>> = {
  created: new Set(["active", "blocked", "inactive", "failed", "cancelled", "archived"]),
  active: new Set(["blocked", "inactive", "completed", "failed", "cancelled", "archived"]),
  blocked: new Set(["active", "inactive", "completed", "failed", "cancelled", "archived"]),
  inactive: new Set(["active", "blocked", "failed", "cancelled", "archived"]),
  completed: new Set(["archived"]),
  merged: new Set(["archived"]),
  failed: new Set(["archived"]),
  cancelled: new Set(["archived"]),
  archived: new Set()
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  pending: new Set(["running", "blocked", "cancelled"]),
  running: new Set(["blocked", "completed", "failed", "cancelled"]),
  blocked: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

const TASK_CREATABLE_BRANCH_STATUSES: ReadonlySet<BranchStatus> = new Set(["created", "active", "blocked", "inactive"]);

const RESULT_CREATABLE_BRANCH_STATUSES: Readonly<Record<BranchResult["status"], ReadonlySet<BranchStatus>>> = {
  completed: new Set(["created", "active", "blocked", "inactive", "completed"]),
  failed: new Set(["created", "active", "blocked", "inactive", "failed"]),
  cancelled: new Set(["created", "active", "blocked", "inactive", "cancelled"])
};

/** 判断会话状态迁移是否合法 */
export function isSessionTransitionAllowed(from: SessionStatus, to: SessionStatus): boolean {
  return from === "active" && to === "archived";
}

/** 判断分支状态迁移是否合法 */
export function isBranchTransitionAllowed(from: BranchStatus, to: BranchStatus): boolean {
  return BRANCH_TRANSITIONS[from].has(to);
}

/** 判断任务状态迁移是否合法 */
export function isTaskTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].has(to);
}

/** 判断任务是否已经进入终态 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 校验分支当前是否允许创建任务 */
export function assertBranchCanCreateTask(branch: ConversationBranch): void {
  if (!TASK_CREATABLE_BRANCH_STATUSES.has(branch.status)) {
    throw new ConversationStoreError(
      "invalid_state_transition",
      `Cannot create a task on branch "${branch.id}" while it is "${branch.status}".`
    );
  }
}

/** 校验分支当前是否允许创建指定结果 */
export function assertBranchCanCreateResult(branch: ConversationBranch, status: BranchResult["status"]): void {
  if (!RESULT_CREATABLE_BRANCH_STATUSES[status].has(branch.status)) {
    throw new ConversationStoreError(
      "invalid_state_transition",
      `Cannot create a "${status}" result while branch "${branch.id}" is "${branch.status}".`
    );
  }
}

/** 校验会话当前是否允许写入 */
export function assertWritableSession(session: ConversationSession): void {
  if (session.status !== "active") {
    throw new ConversationStoreError("invalid_state_transition", `Cannot write to archived session "${session.id}".`);
  }
}

/** 判断事件载荷是否引用指定任务 */
export function payloadContainsTaskId(payload: unknown, taskId: string): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  if ("taskId" in payload && (payload as { readonly taskId?: unknown }).taskId === taskId) {
    return true;
  }
  if ("sourceTaskIds" in payload) {
    const sourceTaskIds = (payload as { readonly sourceTaskIds?: unknown }).sourceTaskIds;
    return Array.isArray(sourceTaskIds) && sourceTaskIds.includes(taskId);
  }
  return false;
}

/** 创建统一的非法状态迁移错误 */
export function invalidTransition(kind: string, id: string, from: string, to: string): ConversationStoreError {
  return new ConversationStoreError(
    "invalid_state_transition",
    `${kind[0]?.toUpperCase()}${kind.slice(1)} "${id}" cannot transition from "${from}" to "${to}".`
  );
}

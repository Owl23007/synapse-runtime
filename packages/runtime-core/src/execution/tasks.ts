import type { ExecutionStorageContext } from "./records.js";
import type { ExecutionStore } from "./store.js";
import type { ExecutionGrant, Task } from "./types.js";
import { keyId, stable, unpack, type Row } from "./records.js";

/** 持久目标的版本、权限与结果存储，所有变更仍使用宿主共享连接 */
export function createTaskStorage(context: ExecutionStorageContext & Pick<ExecutionStore, "authorize" | "forRun">) {
  const methods = {
    /** 模型只创建自己授权域内的目标，父子深度和数量有硬上限 */
    createTask(
      grant: ExecutionGrant,
      input: { key: string; goal: string; acceptance: string; parentId?: string; lineId?: string }
    ): Task {
      context.authorize(grant.id);
      context.checkText(input.goal);
      context.checkText(input.acceptance);
      return context.db
        .transaction(() => {
          // 会话内的模型键只承担局部幂等，不能碰撞到同一主体的其他会话
          const creationKey = grant.sessionId ? keyId("task-key", [grant.sessionId, input.key]) : input.key;
          const id = keyId("task", [
            grant.workspaceId,
            grant.principalId,
            ...(grant.sessionId ? [grant.sessionId] : []),
            input.key
          ]);
          const previous = context.db
            .prepare("SELECT creation_request, record FROM agent_tasks WHERE id = ?")
            .get(id) as (Row & { creation_request: string }) | undefined;
          if (previous) {
            if (previous.creation_request !== stable(input)) throw new Error("Task creation conflict");
            return unpack<Task>(previous)!;
          }
          context.assertCapacity();
          const count = context.db
            .prepare("SELECT count(*) AS count FROM agent_tasks WHERE workspace_id = ?")
            .get(grant.workspaceId) as { count: number };
          if (count.count >= context.settings.maxTasks) throw new Error("Task quota exhausted");
          let parentId = input.parentId;
          let depth = 1;
          while (parentId) {
            if (++depth > context.settings.maxTaskDepth) throw new Error("Task depth exhausted");
            parentId = methods.getTask(parentId, grant).parentId;
          }
          const task: Task = {
            id,
            workspaceId: grant.workspaceId,
            principalId: grant.principalId,
            ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
            ...(input.lineId ? { lineId: input.lineId } : {}),
            goal: input.goal,
            acceptance: input.acceptance,
            status: "open",
            revision: 1,
            progress: "",
            results: [],
            ...(input.parentId ? { parentId: input.parentId } : {})
          };
          context.db
            .prepare("INSERT INTO agent_tasks VALUES (?, ?, ?, ?, 1, 'open', ?, ?, ?)")
            .run(
              id,
              task.workspaceId,
              task.principalId,
              input.parentId ?? null,
              creationKey,
              stable(input),
              stable(task)
            );
          return task;
        })
        .immediate();
    },

    /** 默认目标归属主体私有，共享工作区不隐式分享目标内容 */
    getTask(id: string, grant: ExecutionGrant): Task {
      const task = unpack<Task>(
        context.db
          .prepare("SELECT record FROM agent_tasks WHERE id = ? AND workspace_id = ? AND principal_id = ?")
          .get(id, grant.workspaceId, grant.principalId) as Row | undefined
      );
      if (!task) throw new Error("Task not found or unauthorized");
      return task;
    },

    /** 有界列出当前主体的目标 */
    listTasks(grant: ExecutionGrant): readonly Task[] {
      context.authorize(grant.id);
      return (
        context.db
          .prepare(
            "SELECT record FROM agent_tasks WHERE workspace_id = ? AND principal_id = ? ORDER BY rowid DESC LIMIT ?"
          )
          .all(grant.workspaceId, grant.principalId, context.settings.maxTasks) as Row[]
      ).map((row) => unpack<Task>(row)!);
    },

    /** 已鉴权管理端按工作区检查持久目标，模型工具不暴露此全局入口 */
    inspectTasks(workspaceId?: string): readonly Task[] {
      return (
        context.db
          .prepare(
            `SELECT record FROM agent_tasks ${workspaceId ? "WHERE workspace_id = ?" : ""} ORDER BY rowid DESC LIMIT 200`
          )
          .all(...(workspaceId ? [workspaceId] : [])) as Row[]
      ).map((row) => unpack<Task>(row)!);
    },

    /** 已鉴权管理端按身份读取单个目标 */
    inspectTask(id: string): Task | undefined {
      return unpack<Task>(context.db.prepare("SELECT record FROM agent_tasks WHERE id = ?").get(id) as Row | undefined);
    },

    /** 用户显式控制目标状态仍须检查 revision，不依赖目标原授权是否过期 */
    controlTask(id: string, expectedRevision: number, status: "open" | "paused" | "cancelled"): Task {
      return context.db
        .transaction(() => {
          const task = methods.inspectTask(id);
          if (!task) throw new Error("Task not found");
          if (task.revision !== expectedRevision) throw new Error("Task revision conflict");
          if (["completed", "cancelled"].includes(task.status)) throw new Error("Task is terminal");
          if (!["open", "paused", "cancelled"].includes(status)) throw new Error("Invalid task status");
          const next = { ...task, status, revision: task.revision + 1 };
          context.db
            .prepare("UPDATE agent_tasks SET status = ?, revision = ?, record = ? WHERE id = ? AND revision = ?")
            .run(status, next.revision, stable(next), id, expectedRevision);
          return next;
        })
        .immediate();
    },

    /** 过期结果仍作为事实保留，但不能完成新修订目标 */
    updateTask(
      grant: ExecutionGrant,
      input: {
        id: string;
        expectedRevision: number;
        goal?: string;
        acceptance?: string;
        status?: Task["status"];
        progress?: string;
        result?: { runId: string; revision: number; content: string };
      }
    ): { task: Task; conflict: boolean } {
      context.authorize(grant.id);
      context.checkRecord(input);
      if (
        [input.goal, input.acceptance, input.status, input.progress, input.result].every((value) => value === undefined)
      )
        throw new Error("Task update requires a change");
      if (input.goal !== undefined) context.checkText(input.goal);
      if (input.acceptance !== undefined) context.checkText(input.acceptance);
      if (input.status !== undefined && !["open", "paused", "completed", "cancelled"].includes(input.status))
        throw new Error("Invalid task status");
      return context.db
        .transaction(() => {
          const current = methods.getTask(input.id, grant);
          if (
            input.status === "completed" &&
            (!input.result || input.goal !== undefined || input.acceptance !== undefined)
          )
            throw new Error("Completion requires current revision evidence");
          if (input.result) {
            const execution = context.forRun(input.result.runId);
            if (
              !execution ||
              execution.taskId !== current.id ||
              execution.taskRevision !== input.result.revision ||
              execution.grantId !== grant.id
            )
              throw new Error("Task result source invalid");
            if (input.status === "completed" && execution.state !== "claimed")
              throw new Error("Only an active execution may complete a task");
          }
          const previousResult = input.result
            ? current.results.find(
                (item) => item.runId === input.result!.runId && item.revision === input.result!.revision
              )
            : undefined;
          if (previousResult && previousResult.content !== input.result!.content)
            throw new Error("Task result identity conflict");
          const results = input.result && !previousResult ? [...current.results, input.result] : current.results;
          if (results.length > 128) throw new Error("Task result quota exhausted");
          const conflict =
            current.revision !== input.expectedRevision ||
            Boolean(input.status === "completed" && input.result && input.result.revision !== current.revision);
          if (["completed", "cancelled"].includes(current.status) && !conflict) throw new Error("Task is terminal");
          const task: Task = conflict
            ? { ...current, results }
            : {
                ...current,
                results,
                revision: current.revision + 1,
                ...(input.goal === undefined ? {} : { goal: input.goal }),
                ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.status === "completed" ? { completedByRunId: input.result!.runId } : {}),
                ...(input.progress === undefined ? {} : { progress: input.progress })
              };
          context.checkRecord(task);
          context.db
            .prepare("UPDATE agent_tasks SET revision = ?, status = ?, record = ? WHERE id = ? AND revision = ?")
            .run(task.revision, task.status, stable(task), task.id, current.revision);
          return { task, conflict };
        })
        .immediate();
    }
  };
  return methods;
}

import { z } from "zod";
import { textMessage } from "@synapse/runtime-protocol";
import type { Tool, ToolContext } from "@synapse/runtime-tool-runtime";
import type { ContextGraph } from "../context-graph/index.js";
import type { ExecutionStore } from "./store.js";
import type { ScheduleRule } from "./types.js";

const text = z.string().trim().min(1).max(16_000);
const id = z.string().min(1).max(300);
const revision = z.number().int().positive();
const defined = <T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
const rule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.number().int().positive() }).strict(),
  z
    .object({
      kind: z.literal("interval"),
      startAt: z.number().int().positive(),
      everyMs: z.number().int().min(60_000)
    })
    .strict(),
  z
    .object({
      kind: z.literal("daily"),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      timezone: id
    })
    .strict()
]);

/** 模型领域工具从可信 Run 解析授权，不接受 workspace、principal 或任意通知目标 */
export function createExecutionTools(store: ExecutionStore, graph: ContextGraph): readonly Tool[] {
  const scope = (context: ToolContext) => {
    const intent = store.forRun(context.runId);
    if (!intent || intent.state !== "claimed") throw new Error("Trusted execution required");
    store.validateIntent(intent);
    const grant = store.authorize(intent.grantId);
    if (grant.workspaceId !== context.workspaceId || grant.principalId !== context.userId)
      throw new Error("Execution scope mismatch");
    return { intent, grant, contextScope: grant.sessionId ?? `private:${grant.workspaceId}:${grant.principalId}` };
  };
  const define = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    handle: (input: z.output<T>, context: ToolContext) => unknown | Promise<unknown>
  ): Tool => ({
    name,
    description,
    inputSchema: z.toJSONSchema(schema),
    effect: "transactional",
    permission: { action: "runtime.manage", resource: "execution" },
    available: (context) => store.forRun(context.runId)?.state === "claimed",
    handle: async (input, context) => {
      scope(context);
      return store.transactionalTool(context.callId!, () => handle(schema.parse(input), context));
    }
  });
  return [
    define(
      "task.get",
      "显式读取并采用当前任务修订；修订目标或进度后再次读取才可按新 revision 完成",
      z.object({ id }).strict(),
      (input, context) => store.readTask(context.runId, input.id)
    ),
    define(
      "task.create",
      "需要跨运行持续目标时创建任务，普通问答无需任务",
      z.object({ key: id, goal: text, acceptance: text, parentId: id.optional() }).strict(),
      (input, context) => store.createTask(scope(context).grant, defined(input))
    ),
    define("task.list", "列出当前主体有权读取的持久目标", z.object({}).strict(), (_input, context) =>
      store.listTasks(scope(context).grant)
    ),
    define(
      "task.run",
      "排队推进一个已有目标；本轮结束后由同一执行内核领取，不能绕过宿主额度",
      z.object({ id, key: id, instruction: text }).strict(),
      (input, context) => store.advanceTask(scope(context).grant, input)
    ),
    define(
      "task.update",
      "按 revision 修改目标、进度或状态；过期产出保留但不能完成新目标",
      z
        .object({
          id,
          expectedRevision: revision,
          goal: text.optional(),
          acceptance: text.optional(),
          progress: text.optional(),
          status: z.enum(["open", "paused", "completed", "cancelled"]).optional(),
          result: text.optional()
        })
        .strict(),
      (input, context) => {
        const { intent, grant } = scope(context);
        const { result, ...patch } = input;
        if (
          patch.status === "completed" &&
          (!result || intent.taskId !== patch.id || patch.goal !== undefined || patch.acceptance !== undefined)
        )
          throw new Error("Completion requires current task evidence without revising the goal");
        return store.updateTask(grant, {
          ...defined(patch),
          ...(result ? { result: { runId: intent.runId, revision: intent.taskRevision ?? 0, content: result } } : {})
        });
      }
    ),
    define(
      "schedule.create",
      "创建有限次数、有限寿命的未来工作或确定提醒；daily 使用 IANA 时区，interval 使用 UTC 实际间隔",
      z
        .object({
          key: id,
          rule,
          instruction: text,
          mode: z.enum(["agent", "reminder"]),
          taskId: id.optional(),
          expiresAt: z.number().int().positive().optional(),
          maxOccurrences: z.number().int().positive().optional(),
          missed: z.enum(["skip", "coalesce"]).optional(),
          overlap: z.enum(["skip", "queue"]).optional()
        })
        .strict(),
      (input, context) =>
        store.createSchedule(scope(context).grant, { ...defined(input), rule: input.rule as ScheduleRule })
    ),
    define("schedule.list", "读取当前主体的计划及剩余额度", z.object({}).strict(), (_input, context) =>
      store.listSchedules(scope(context).grant)
    ),
    define(
      "schedule.update",
      "按 revision 修改、暂停、恢复或取消计划，不延长宿主授权和次数额度",
      z
        .object({
          id,
          expectedRevision: revision,
          status: z.enum(["active", "paused", "cancelled"]).optional(),
          instruction: text.optional(),
          rule: rule.optional()
        })
        .strict(),
      ({ id: scheduleId, expectedRevision, ...patch }, context) =>
        store.updateSchedule(scope(context).grant, scheduleId, expectedRevision, defined(patch))
    ),
    define("context.refs", "列出当前授权范围的版本入口，不读取其他会话历史", z.object({}).strict(), (_input, context) =>
      store.contextRefs(scope(context).contextScope)
    ),
    define(
      "context.read",
      "读取当前授权范围的指定不可变上下文版本，读取不会重放历史工具动作",
      z.object({ commitId: id }).strict(),
      ({ commitId }, context) => {
        const commit = graph.getCommit(scope(context).contextScope, commitId);
        if (!commit) throw new Error("Context version not found or unauthorized");
        return commit;
      }
    ),
    define(
      "context.commit",
      "显式保存可继续工作的完整逻辑快照，使用 Ref CAS；不自动保存工具轨迹",
      z
        .object({
          key: id,
          refName: id,
          expectedVersion: z.number().int().positive().nullable(),
          content: z.record(z.string(), z.unknown()),
          parents: z.array(id).max(8).default([])
        })
        .strict(),
      (input, context) => {
        const { contextScope, intent } = scope(context);
        return store.commitContext(contextScope, input.key, () =>
          graph.commit({
            scopeId: contextScope,
            refName: input.refName,
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.key,
            type: "snapshot",
            content: input.content,
            additionalParents: input.parents,
            metadata: { runId: intent.runId }
          })
        );
      }
    ),
    define(
      "runtime.finish",
      "结束当前推理：silent 不发消息；reply 回复来源；notify 向授权来源通知；waiting 依赖已创建计划",
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("silent") }).strict(),
        z.object({ kind: z.literal("reply"), text }).strict(),
        z.object({ kind: z.literal("notify"), text }).strict(),
        z.object({ kind: z.literal("waiting"), scheduleId: id }).strict()
      ]),
      (input, context) => {
        const { intent, grant } = scope(context);
        if (input.kind === "waiting") {
          const schedule = input.scheduleId ? store.schedule(input.scheduleId) : undefined;
          if (!schedule || schedule.grantId !== grant.id || schedule.status !== "active")
            throw new Error("Waiting requires an active authorized schedule");
          store.saveResult(intent.runId, { kind: "waiting", scheduleId: schedule.id });
        } else if (input.kind === "silent") store.saveResult(intent.runId, { kind: "silent" });
        else {
          if (!input.text) throw new Error("Output text required");
          store.saveResult(intent.runId, { kind: input.kind, message: textMessage(input.text) });
        }
        return { accepted: true };
      }
    )
  ];
}

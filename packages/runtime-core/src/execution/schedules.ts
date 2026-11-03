import type { ExecutionStorageContext } from "./records.js";
import type { ExecutionStore } from "./store.js";
import type { ExecutionGrant, Schedule, ScheduleRule } from "./types.js";
import { ExecutionLimitError, keyId, stable, unpack, type Row } from "./records.js";
import type { AgentRequest } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import { textMessage } from "@synapse/runtime-protocol";
import { nextScheduleTime } from "./time.js";

/** 时间计划与 occurrence 的原子存储，所有变更仍使用宿主共享连接 */
export function createScheduleStorage(
  context: ExecutionStorageContext & Pick<ExecutionStore, "authorize" | "getGrant" | "accept">
) {
  const methods = {
    /** 创建有限次数和寿命的计划，授权域与通知源只能继承当前执行 */
    createSchedule(
      grant: ExecutionGrant,
      input: {
        key: string;
        rule: ScheduleRule;
        instruction: string;
        mode: Schedule["mode"];
        taskId?: string;
        expiresAt?: number;
        maxOccurrences?: number;
        missed?: Schedule["missed"];
        overlap?: Schedule["overlap"];
      },
      now = Date.now()
    ): Schedule {
      if (!context.settings.enabled) throw new Error("Autonomous scheduling disabled");
      context.authorize(grant.id, input.taskId, now);
      context.checkText(input.instruction);
      return context.db
        .transaction(() => {
          const id = keyId("schedule", [grant.id, input.key]);
          const previous = context.db
            .prepare("SELECT record, creation_request FROM agent_schedules WHERE id = ?")
            .get(id) as (Row & { creation_request: string }) | undefined;
          if (previous) {
            if (previous.creation_request !== stable(input)) throw new Error("Schedule creation conflict");
            return unpack<Schedule>(previous)!;
          }
          context.assertCapacity();
          const count = context.db
            .prepare("SELECT count(*) AS count FROM agent_schedules WHERE workspace_id = ?")
            .get(grant.workspaceId) as { count: number };
          if (count.count >= context.settings.maxSchedules) throw new Error("Schedule quota exhausted");
          if (input.rule.kind === "interval" && input.rule.everyMs < context.settings.minScheduleIntervalMs)
            throw new Error("Schedule interval below host minimum");
          const nextFireAt = nextScheduleTime(input.rule, now);
          const expiresAt = Math.min(
            input.expiresAt ?? Infinity,
            grant.expiresAt,
            now + context.settings.maxScheduleLifetimeHours * 3_600_000
          );
          const maxOccurrences = input.maxOccurrences ?? context.settings.maxScheduleOccurrences;
          if (
            !nextFireAt ||
            nextFireAt >= expiresAt ||
            !Number.isInteger(maxOccurrences) ||
            maxOccurrences < 1 ||
            maxOccurrences > context.settings.maxScheduleOccurrences
          )
            throw new Error("Schedule exceeds time or occurrence budget");
          const schedule: Schedule = {
            id,
            grantId: grant.id,
            workspaceId: grant.workspaceId,
            rule: input.rule,
            instruction: input.instruction,
            mode: input.mode,
            status: "active",
            revision: 1,
            nextFireAt,
            expiresAt,
            maxOccurrences,
            fired: 0,
            missed: input.missed ?? "coalesce",
            overlap: input.overlap ?? "skip",
            ...(input.taskId ? { taskId: input.taskId } : {})
          };
          context.db
            .prepare("INSERT INTO agent_schedules VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)")
            .run(
              id,
              grant.id,
              grant.workspaceId,
              input.taskId ?? null,
              nextFireAt,
              input.key,
              stable(input),
              stable(schedule)
            );
          return schedule;
        })
        .immediate();
    },

    /** 读取计划快照，调用方必须先验证所属授权 */
    schedule(id: string): Schedule | undefined {
      return unpack(context.db.prepare("SELECT record FROM agent_schedules WHERE id = ?").get(id) as Row | undefined);
    },

    /** 主体只能列出自己创建的计划 */
    listSchedules(grant: ExecutionGrant): readonly Schedule[] {
      context.authorize(grant.id);
      return (
        context.db
          .prepare(
            "SELECT s.record FROM agent_schedules s JOIN execution_grants g ON g.id = s.grant_id WHERE s.workspace_id = ? AND g.principal_id = ? ORDER BY s.rowid DESC LIMIT ?"
          )
          .all(grant.workspaceId, grant.principalId, context.settings.maxSchedules) as Row[]
      ).map((row) => unpack<Schedule>(row)!);
    },

    /** 修改、暂停与取消均增加修订，不复活已产生的旧 occurrence */
    updateSchedule(
      grant: ExecutionGrant,
      id: string,
      expectedRevision: number,
      patch: { status?: "active" | "paused" | "cancelled"; instruction?: string; rule?: ScheduleRule },
      now = Date.now()
    ): Schedule {
      context.authorize(grant.id, undefined, now);
      context.checkRecord(patch);
      if ([patch.status, patch.instruction, patch.rule].every((value) => value === undefined))
        throw new Error("Schedule update requires a change");
      if (patch.instruction !== undefined) context.checkText(patch.instruction);
      if (patch.status !== undefined && !["active", "paused", "cancelled"].includes(patch.status))
        throw new Error("Invalid schedule status");
      return context.db
        .transaction(() => {
          const current = methods.schedule(id);
          const owner = current && context.getGrant(current.grantId);
          if (!current || owner?.workspaceId !== grant.workspaceId || owner.principalId !== grant.principalId)
            throw new Error("Schedule unauthorized");
          if (current.revision !== expectedRevision) throw new Error("Schedule revision conflict");
          if (current.status === "cancelled" || (current.status === "completed" && patch.status !== "cancelled"))
            throw new Error("Schedule terminal");
          const rule = patch.rule ?? current.rule;
          if (rule.kind === "interval" && rule.everyMs < context.settings.minScheduleIntervalMs)
            throw new Error("Schedule interval below host minimum");
          const next = patch.rule || patch.status === "active" ? nextScheduleTime(rule, now) : current.nextFireAt;
          if (!next || next >= current.expiresAt) throw new Error("Schedule expired");
          const schedule: Schedule = { ...current, ...patch, rule, nextFireAt: next, revision: current.revision + 1 };
          methods.writeSchedule(schedule);
          return schedule;
        })
        .immediate();
    },

    /** 到期事实、标准 Intent 和 nextFireAt 原子提交，重启不能重复领取同一时刻 */
    tick(now = Date.now()): number {
      if (!context.settings.enabled) return 0;
      const due = context.db
        .prepare(
          "SELECT record FROM agent_schedules WHERE status = 'active' AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 100"
        )
        .all(now) as Row[];
      let count = 0;
      for (const row of due) {
        try {
          context.db
            .transaction(() => {
              const candidate = unpack<Schedule>(row)!;
              const schedule = methods.schedule(candidate.id)!;
              if (schedule.status !== "active" || schedule.nextFireAt > now) return;
              let grant: ExecutionGrant;
              try {
                grant = context.authorize(schedule.grantId, schedule.taskId, now);
              } catch {
                methods.writeSchedule({ ...schedule, status: "cancelled" });
                return;
              }
              if (schedule.expiresAt <= now || schedule.fired >= schedule.maxOccurrences) {
                methods.writeSchedule({ ...schedule, status: "completed" });
                return;
              }
              const overlap = context.db
                .prepare(
                  "SELECT 1 FROM execution_intents WHERE schedule_id = ? AND state IN ('queued','claimed') LIMIT 1"
                )
                .get(schedule.id);
              const missed =
                schedule.missed === "skip" && now - schedule.nextFireAt > context.settings.pollIntervalMs * 2;
              const skip = missed || (overlap && schedule.overlap === "skip");
              let intentId: string | null = null;
              if (!skip) {
                const event: SynapseChannelEvent = {
                  id: `occurrence:${schedule.id}:${schedule.revision}:${schedule.nextFireAt}`,
                  platform: grant.source.platform as SynapseChannelEvent["platform"],
                  channelId: grant.source.channelId,
                  eventType: "schedule.due",
                  origin: "incoming",
                  conversation: {
                    id: grant.source.conversationId,
                    kind: grant.source.conversationKind as SynapseChannelEvent["conversation"]["kind"]
                  },
                  sender: { id: grant.principalId },
                  receivedAt: new Date(schedule.nextFireAt).toISOString(),
                  message: textMessage(schedule.instruction)
                };
                const request: AgentRequest = {
                  sessionId: grant.sessionId ?? "",
                  workspaceId: grant.workspaceId,
                  userId: grant.principalId,
                  ...(schedule.taskId ? { taskId: schedule.taskId } : {}),
                  input: event.message!,
                  source: grant.source,
                  event,
                  contextPolicy: { includeHistory: false, maxMessages: 0 }
                };
                const intent = context.accept(
                  {
                    key: event.id,
                    grantId: grant.id,
                    payload: {
                      event,
                      request,
                      ...(schedule.mode === "reminder" ? { reminder: schedule.instruction } : {})
                    },
                    scheduleId: schedule.id,
                    scheduleRevision: schedule.revision,
                    ...(schedule.taskId ? { taskId: schedule.taskId } : {})
                  },
                  now
                );
                intentId = intent.id;
                count++;
              }
              context.db
                .prepare("INSERT INTO schedule_occurrences VALUES (?, ?, ?, ?, ?, ?)")
                .run(schedule.id, schedule.revision, schedule.nextFireAt, intentId, skip ? "skipped" : "accepted", now);
              const next = nextScheduleTime(schedule.rule, now);
              const fired = schedule.fired + 1;
              methods.writeSchedule({
                ...schedule,
                fired,
                nextFireAt: next ?? schedule.nextFireAt,
                status: !next || next >= schedule.expiresAt || fired >= schedule.maxOccurrences ? "completed" : "active"
              });
            })
            .immediate();
        } catch (error) {
          if (!(error instanceof ExecutionLimitError)) throw error;
          if (error.kind === "grant") {
            const schedule = unpack<Schedule>(row)!;
            methods.writeSchedule({ ...schedule, status: "completed", stopReason: "grant_budget" });
          }
        }
      }
      return count;
    },

    writeSchedule(schedule: Schedule): void {
      context.db
        .prepare("UPDATE agent_schedules SET revision = ?, status = ?, next_fire_at = ?, record = ? WHERE id = ?")
        .run(schedule.revision, schedule.status, schedule.nextFireAt, stable(schedule), schedule.id);
    }
  };
  return methods;
}

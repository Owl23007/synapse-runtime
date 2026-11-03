import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { getTextContent, textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { AutonomySettingsSchema, type AutonomySettings } from "../config.js";
import type { RunTraceStore, RunTrace } from "../trace/types.js";
import type { ExecutionGrant, ExecutionIntent, OutputIntent, Schedule, ScheduleRule, Task } from "./types.js";
import { EXECUTION_SCHEMA_SQL } from "./schema.js";
import { nextScheduleTime } from "./time.js";
import type { Commit } from "../context-graph/index.js";
import type { AcceptNormalizedEventInput, AcceptedNormalizedEvent } from "../conversation/types.js";
import { redactTrace } from "../trace/redact.js";
import { decodeJson } from "../storage/sqlite/json-codec.js";
import { isDeepStrictEqual } from "node:util";
import type { ModelFailure } from "@synapse/runtime-agent-core";

type StoredIntent = Omit<ExecutionIntent, "payload"> & {
  format: 1;
  payload: {
    request: Omit<AgentRequest, "input" | "event">;
    event: Omit<SynapseChannelEvent, "message">;
    input?: AgentRequest["input"];
    scope?: { provider: string; eventId: string };
    reminder?: string;
    deliveryOfRunId?: string;
  };
};

class ExecutionLimitError extends Error {
  constructor(
    readonly kind: "capacity" | "rate" | "grant" | "storage",
    message: string
  ) {
    super(message);
  }
}

type Row = { record: string };
const unpack = <T>(row: Row | undefined): T | undefined => (row ? (JSON.parse(row.record) as T) : undefined);
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
const keyId = (kind: string, values: unknown) => `${kind}:${createHash("sha256").update(stable(values)).digest("hex")}`;

/** 同库持久执行内核，事务只包含本地事实写入，不执行模型或网络调用 */
export class ExecutionStore {
  /** 宿主设置的固定限额，运行与模型工具均不能覆盖 */
  readonly settings: AutonomySettings;

  /** 初始化领域表并设置数据库文件增长上限，不删除既有数据 */
  constructor(
    private readonly db: Database.Database,
    private readonly runs: RunTraceStore,
    settings: Partial<AutonomySettings> = {},
    private readonly acceptEvent?: (input: AcceptNormalizedEventInput) => AcceptedNormalizedEvent,
    private readonly secrets: readonly string[] = [],
    private readonly readEvent?: (eventId: string) => AcceptedNormalizedEvent
  ) {
    this.settings = Object.freeze(AutonomySettingsSchema.parse(settings));
    db.transaction(() => {
      const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'execution_schema'").get();
      if (
        existing &&
        (db.prepare("SELECT version FROM execution_schema").all() as { version: number }[]).some(
          (row) => ![1, 2].includes(row.version)
        )
      )
        throw new Error("Unsupported execution schema");
      if (existing && (db.prepare("SELECT version FROM execution_schema").get() as { version: number }).version === 1) {
        db.exec(
          "ALTER TABLE execution_intents ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0; DROP TABLE execution_schema"
        );
      }
      db.exec(EXECUTION_SCHEMA_SQL);
      const oldBindings = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_workspaces'").get();
      if (oldBindings) {
        if (
          db
            .prepare(
              "SELECT 1 FROM session_workspaces b JOIN conversation_sessions s ON s.id = b.session_id WHERE s.workspace_id IS NOT NULL AND s.workspace_id != b.workspace_id LIMIT 1"
            )
            .get()
        )
          throw new Error("Conflicting session workspace bindings require an explicit repair");
        db.exec(
          "UPDATE conversation_sessions SET workspace_id = (SELECT workspace_id FROM session_workspaces WHERE session_id = conversation_sessions.id) WHERE workspace_id IS NULL AND id IN (SELECT session_id FROM session_workspaces); DROP TABLE session_workspaces"
        );
      }
      db.exec(
        "CREATE TRIGGER IF NOT EXISTS session_workspace_immutable BEFORE UPDATE OF workspace_id ON conversation_sessions WHEN OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS NOT OLD.workspace_id BEGIN SELECT RAISE(ABORT, 'Session workspace is immutable'); END"
      );
    }).immediate();
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    const pages = Number(db.pragma("page_count", { simple: true }));
    db.pragma(`max_page_count = ${Math.max(pages, Math.floor(this.settings.maxDatabaseBytes / pageSize))}`);
  }

  /** 管理协议出口统一脱敏，权威运行输入仍保留原始事实 */
  inspect(value: unknown): unknown {
    return redactTrace(value, this.secrets);
  }

  /** 规范输入、意图与本地引用原子接受，回调不得跨越异步边界 */
  acceptInput(
    input: AcceptNormalizedEventInput,
    build: (accepted: AcceptedNormalizedEvent) => Parameters<ExecutionStore["accept"]>[0],
    afterAccept?: (intent: ExecutionIntent) => void
  ): { accepted: AcceptedNormalizedEvent; intent: ExecutionIntent } {
    if (!this.acceptEvent) throw new Error("Atomic input store required");
    return this.db
      .transaction(() => {
        this.assertCapacity();
        this.checkRecord(input.message ?? textMessage(input.text));
        const accepted = this.acceptEvent!(input);
        const intent = this.accept(build(accepted));
        this.db
          .prepare("INSERT OR IGNORE INTO execution_input_receipts VALUES (?, ?)")
          .run(accepted.event.id, intent.runId);
        if (this.inputRun(input.idempotencyKey)?.id !== intent.runId) throw new Error("Input run identity conflict");
        const projection: unknown = afterAccept?.(intent);
        if (projection && typeof (projection as PromiseLike<unknown>).then === "function")
          throw new Error("Input projections must be synchronous");
        return { accepted, intent };
      })
      .immediate();
  }

  /** 补充消息先成为规范事实，再在同一事务关联 Inbox 和附件，重投仍返回原 Run */
  acceptSupplement(
    runId: string,
    input: AcceptNormalizedEventInput,
    afterAccept?: (receipt: { runId: string }) => void
  ): RunTrace {
    if (!this.acceptEvent) throw new Error("Atomic input store required");
    return this.db
      .transaction(() => {
        this.assertCapacity();
        this.checkRecord(input.message ?? textMessage(input.text));
        const accepted = this.acceptEvent!(input);
        const previous = this.inputRun(input.idempotencyKey);
        if (previous && previous.id !== runId) throw new Error("Supplement already belongs to another run");
        const run = previous ?? this.runs.get(runId);
        const intent = this.forRun(runId);
        if (
          !run ||
          input.sessionId !== run.sessionId ||
          input.workspaceId !== run.workspaceId ||
          accepted.event.lineId !== run.lineId
        )
          throw new Error("Supplement scope mismatch");
        if (!previous) {
          if (!intent) throw new Error("Execution intent missing");
          this.validateIntent(intent);
          const grant = this.authorize(intent.grantId);
          const assets = accepted.event.message?.assets;
          const content = `${grant.source.conversationKind === "group" ? `${accepted.event.senderId}: ` : ""}${accepted.event.text}${assets?.length ? `\n附件引用：${JSON.stringify(assets)}` : ""}`;
          this.enqueueInput(runId, accepted.event.id, content);
          this.db.prepare("INSERT INTO execution_input_receipts VALUES (?, ?)").run(accepted.event.id, runId);
        }
        const projection: unknown = afterAccept?.({ runId });
        if (projection && typeof (projection as PromiseLike<unknown>).then === "function")
          throw new Error("Input projections must be synchronous");
        return run;
      })
      .immediate();
  }

  /** 精确定位规范补充消息所属的运行，完成后的重投也不创建新执行 */
  inputRun(inputKey: string): RunTrace | undefined {
    const row = this.db
      .prepare(
        "SELECT i.run_id FROM execution_input_receipts i JOIN normalized_events e ON e.id = i.event_id WHERE e.idempotency_key = ?"
      )
      .get(inputKey) as { run_id: string } | undefined;
    return row ? this.runs.get(row.run_id) : undefined;
  }

  /** 接受新工作前预留收尾空间，满额时拒绝增长并保留未决回执 */
  assertCapacity(): void {
    const size = Number(this.db.pragma("page_size", { simple: true }));
    const used =
      Number(this.db.pragma("page_count", { simple: true })) -
      Number(this.db.pragma("freelist_count", { simple: true }));
    const reserve = Math.min(
      Math.floor(this.settings.maxDatabaseBytes / 4),
      Math.max(8 * 1024 * 1024, this.settings.maxRecordChars * 16)
    );
    if (used * size + reserve >= this.settings.maxDatabaseBytes)
      throw new ExecutionLimitError("storage", "Runtime database capacity exhausted");
  }

  /** 宿主根据可信输入签发有限授权，重复输入不延长已签发授权 */
  issueGrant(
    input: Omit<ExecutionGrant, "id" | "revoked" | "expiresAt"> & { readonly key: string; readonly expiresAt?: number },
    now = Date.now()
  ): ExecutionGrant {
    const id = keyId("grant", [input.workspaceId, input.principalId, input.key]);
    const previous = this.getGrant(id);
    if (previous) {
      if (stable(previous.source) !== stable(input.source) || previous.sessionId !== input.sessionId)
        throw new Error("Grant identity conflict");
      return previous;
    }
    this.assertCapacity();
    const { key: _key, ...scope } = input;
    const grant: ExecutionGrant = {
      ...scope,
      id,
      revoked: false,
      expiresAt: Math.min(input.expiresAt ?? Infinity, now + this.settings.maxScheduleLifetimeHours * 3_600_000)
    };
    this.db
      .prepare("INSERT INTO execution_grants VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(id, grant.workspaceId, grant.principalId, grant.sessionId ?? null, grant.expiresAt, stable(grant));
    return grant;
  }

  /** 当前授权状态是执行和发送时的权威来源 */
  getGrant(id: string): ExecutionGrant | undefined {
    return unpack(this.db.prepare("SELECT record FROM execution_grants WHERE id = ?").get(id) as Row | undefined);
  }

  /** 撤权阻止排队工作、模型新步骤和通知，不删除已有结果 */
  revokeGrant(id: string): void {
    const grant = this.getGrant(id);
    if (!grant) throw new Error("Grant not found");
    this.db
      .transaction(() => {
        this.db
          .prepare("UPDATE execution_grants SET revoked = 1, record = ? WHERE id = ?")
          .run(stable({ ...grant, revoked: true }), id);
        this.db
          .prepare("UPDATE execution_intents SET state = 'blocked' WHERE grant_id = ? AND state = 'queued'")
          .run(id);
      })
      .immediate();
  }

  /** 每次执行和副作用边界重新检查撤权、过期、计划及目标状态 */
  authorize(grantId: string, taskId?: string, now = Date.now()): ExecutionGrant {
    const grant = this.getGrant(grantId);
    if (!grant || grant.revoked || grant.expiresAt <= now)
      throw new Error("Execution authorization expired or revoked");
    if (taskId) {
      const task = this.getTask(taskId, grant);
      if (task.status !== "open") throw new Error("Task is not open");
    }
    return grant;
  }

  /** 同一逻辑请求只接受一次，运行和执行意图同事务提交 */
  accept(
    input: {
      readonly key: string;
      readonly grantId: string;
      readonly payload: ExecutionIntent["payload"];
      readonly taskId?: string;
      readonly scheduleId?: string;
      readonly scheduleRevision?: number;
    },
    now = Date.now()
  ): ExecutionIntent {
    return this.db
      .transaction(() => {
        const source = input.payload.request.source;
        const id = keyId("intent", [source.platform, source.channelId, source.conversationId, input.key]);
        const previous = this.getIntent(id);
        if (previous) {
          if (
            previous.grantId !== input.grantId ||
            stable(previous.payload) !== stable(input.payload) ||
            previous.taskId !== input.taskId
          )
            throw new Error("Execution intent identity conflict");
          return previous;
        }
        this.assertCapacity();
        const grant = this.authorize(input.grantId, input.taskId, now);
        const pending = this.db
          .prepare("SELECT count(*) AS count FROM execution_intents WHERE state IN ('queued','claimed')")
          .get() as { count: number };
        if (pending.count >= this.settings.maxPendingIntents)
          throw new ExecutionLimitError("capacity", "Execution intent capacity exhausted");
        const recent = this.db
          .prepare("SELECT count(*) AS count FROM execution_intents WHERE workspace_id = ? AND created_at > ?")
          .get(grant.workspaceId, now - 3_600_000) as { count: number };
        if (recent.count >= this.settings.maxRunsPerHour)
          throw new ExecutionLimitError("rate", "Workspace execution rate exhausted");
        const lifetime = this.db
          .prepare("SELECT count(*) AS count FROM execution_intents WHERE grant_id = ?")
          .get(grant.id) as { count: number };
        if (lifetime.count >= this.settings.maxRunsPerGrant)
          throw new ExecutionLimitError("grant", "Authorization execution budget exhausted");
        const request = input.payload.request;
        if (
          request.workspaceId !== grant.workspaceId ||
          request.userId !== grant.principalId ||
          (grant.sessionId ?? "") !== request.sessionId
        )
          throw new Error("Execution scope does not match authorization");
        const lineId = input.payload.scope?.accepted.lineEvent.lineId ?? request.lineId;
        const branchId =
          input.payload.scope && lineId !== input.payload.scope.accepted.mainline.id ? lineId : request.branchId;
        const run = this.runs.accept({
          sourceEventId: input.payload.scope?.accepted.event.id ?? id,
          ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
          workspaceId: grant.workspaceId,
          channelId: request.source.channelId,
          ...(lineId ? { lineId } : {}),
          ...(branchId ? { branchId } : {}),
          summary: input.payload.reminder ?? getTextContent(request.input)
        });
        const intent: ExecutionIntent = {
          id,
          runId: run.id,
          grantId: grant.id,
          workspaceId: grant.workspaceId,
          state: "queued",
          attempts: 0,
          availableAt: 0,
          createdAt: now,
          ...(input.taskId ? { taskId: input.taskId, taskRevision: this.getTask(input.taskId, grant).revision } : {}),
          ...(input.scheduleId ? { scheduleId: input.scheduleId, scheduleRevision: input.scheduleRevision! } : {}),
          payload: input.payload
        };
        this.db
          .prepare(
            "INSERT INTO execution_intents(id, run_id, grant_id, workspace_id, task_id, schedule_id, state, created_at, record) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)"
          )
          .run(
            id,
            run.id,
            grant.id,
            grant.workspaceId,
            input.taskId ?? null,
            input.scheduleId ?? null,
            now,
            this.serializeIntent(intent)
          );
        return intent;
      })
      .immediate();
  }

  /** 运行身份定位用于模型工具绑定，不能由模型选择其他运行 */
  forRun(runId: string): ExecutionIntent | undefined {
    const row = this.db.prepare("SELECT id FROM execution_intents WHERE run_id = ?").get(runId) as
      | { id: string }
      | undefined;
    return row ? this.getIntent(row.id) : undefined;
  }

  /** 当前主体在同一交互来源中的补充信息优先进入已有运行 */
  activeForSession(sessionId: string, principalId: string): ExecutionIntent | undefined {
    const row = this.db
      .prepare(
        "SELECT i.id FROM execution_intents i JOIN execution_grants g ON g.id = i.grant_id WHERE i.state = 'claimed' AND g.session_id = ? AND g.principal_id = ? ORDER BY i.ordinal LIMIT 1"
      )
      .get(sessionId, principalId) as { id: string } | undefined;
    return row ? this.getIntent(row.id) : undefined;
  }

  /** 持久队列状态列覆盖快照，避免重复的状态来源 */
  getIntent(id: string): ExecutionIntent | undefined {
    const row = this.db
      .prepare("SELECT record, state, attempts, next_attempt_at FROM execution_intents WHERE id = ?")
      .get(id) as (Row & { state: ExecutionIntent["state"]; attempts: number; next_attempt_at: number }) | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(row.record) as StoredIntent;
    if (stored.format !== 1) throw new Error("Unsupported execution envelope");
    const accepted = stored.payload.scope ? this.readEvent?.(stored.payload.scope.eventId) : undefined;
    const input = accepted ? (accepted.event.message ?? textMessage(accepted.event.text)) : stored.payload.input;
    if (!input || (stored.payload.scope && !accepted)) throw new Error("Canonical execution input unavailable");
    const event: SynapseChannelEvent = { ...stored.payload.event, message: input };
    const { scope: savedScope, input: _input, request, ...payload } = stored.payload;
    const { format: _format, ...intent } = stored;
    return {
      ...intent,
      state: row.state,
      attempts: row.attempts,
      availableAt: row.next_attempt_at,
      payload: {
        ...payload,
        event,
        request: { ...request, event, input },
        ...(savedScope ? { scope: { provider: savedScope.provider, accepted: accepted! } } : {})
      }
    };
  }

  /** 有界枚举待办，内存队列仅缓存已经持久接受的工作 */
  pending(limit = 32): readonly ExecutionIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid intent page");
    return (
      this.db
        .prepare("SELECT id FROM execution_intents WHERE state = 'queued' ORDER BY ordinal LIMIT ?")
        .all(limit) as { id: string }[]
    ).map((row) => this.getIntent(row.id)!);
  }

  /** 每个空闲目标只提出最早候选，阻塞目标不占用其他目标的调度名额 */
  runnable(limit: number, now = Date.now()): readonly ExecutionIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid intent page");
    return (
      this.db
        .prepare(`SELECT i.id FROM execution_intents i
      WHERE i.state = 'queued' AND i.next_attempt_at <= ? AND (
        i.task_id IS NULL OR (
          NOT EXISTS (SELECT 1 FROM execution_intents running WHERE running.task_id = i.task_id AND running.state = 'claimed')
          AND NOT EXISTS (SELECT 1 FROM execution_intents earlier WHERE earlier.task_id = i.task_id AND earlier.state = 'queued' AND earlier.next_attempt_at <= ? AND earlier.ordinal < i.ordinal)
        )
      ) ORDER BY i.ordinal LIMIT ?`)
        .all(now, now, limit) as { id: string }[]
    ).map((row) => this.getIntent(row.id)!);
  }

  /** 同一 Task 单推进者，计划取消和撤权在领取时重新校验 */
  claim(id: string, now = Date.now()): ExecutionIntent | undefined {
    return this.db
      .transaction(() => {
        const intent = this.getIntent(id);
        if (!intent || intent.state !== "queued" || intent.availableAt > now) return undefined;
        try {
          this.validateIntent(intent, now);
        } catch {
          this.db.prepare("UPDATE execution_intents SET state = 'blocked' WHERE id = ?").run(id);
          this.blockRun(intent.runId, "authorization_invalid");
          return undefined;
        }
        if (intent.attempts >= this.settings.maxAttempts) {
          this.db.prepare("UPDATE execution_intents SET state = 'blocked' WHERE id = ?").run(id);
          this.blockRun(intent.runId, "attempt_limit");
          return undefined;
        }
        if (
          intent.taskId &&
          this.db.prepare("SELECT 1 FROM execution_intents WHERE task_id = ? AND state = 'claimed'").get(intent.taskId)
        )
          return undefined;
        const adopted = intent.taskId
          ? {
              ...intent,
              taskRevision:
                this.getTask(intent.taskId, this.authorize(intent.grantId, undefined, now)).status === "open"
                  ? this.getTask(intent.taskId, this.authorize(intent.grantId, undefined, now)).revision
                  : intent.taskRevision!
            }
          : intent;
        this.db
          .prepare(
            "UPDATE execution_intents SET state = 'claimed', attempts = attempts + 1, record = ?, next_attempt_at = 0 WHERE id = ? AND state = 'queued'"
          )
          .run(this.serializeIntent(adopted), id);
        return this.getIntent(id);
      })
      .immediate();
  }

  /** 执行前及每个模型和副作用边界校验动态授权 */
  validateIntent(intent: ExecutionIntent, now = Date.now()): void {
    if (!intent.payload.scope && !this.settings.enabled) throw new Error("Autonomous execution disabled");
    const grant = this.authorize(intent.grantId, undefined, now);
    if (intent.taskId) {
      const task = this.getTask(intent.taskId, grant);
      const completedHere = task.status === "completed" && task.completedByRunId === intent.runId;
      if (task.status !== "open" && !completedHere) throw new Error("Task no longer authorizes execution");
    }
    if (intent.scheduleId) {
      const schedule = this.schedule(intent.scheduleId);
      if (
        !schedule ||
        schedule.revision !== intent.scheduleRevision ||
        ["paused", "cancelled"].includes(schedule.status) ||
        schedule.expiresAt <= now
      )
        throw new Error("Schedule no longer authorizes execution");
    }
  }

  /** 已提交结果独立于消息交付，崩溃后只重做缺失交付 */
  saveResult(runId: string, outcome: OutputIntent): void {
    this.checkRecord(outcome);
    const prior = this.result(runId);
    if (prior && stable(prior) !== stable(outcome)) throw new Error("Execution result conflict");
    this.db.prepare("INSERT OR IGNORE INTO execution_results VALUES (?, ?, ?)").run(runId, stable(outcome), Date.now());
  }

  /** 读取权威执行结果，不从已发送消息反向猜测结果 */
  result(runId: string): OutputIntent | undefined {
    const row = this.db.prepare("SELECT outcome FROM execution_results WHERE run_id = ?").get(runId) as
      | { outcome: string }
      | undefined;
    return row ? (JSON.parse(row.outcome) as OutputIntent) : undefined;
  }

  /** 显式提交具有总量上限，幂等重试不消耗新额度 */
  commitContext(scopeId: string, key: string, commit: () => Commit): Commit {
    return this.db
      .transaction(() => {
        const exists = this.db
          .prepare("SELECT 1 FROM context_graph_commit_request WHERE scope_id = ? AND idempotency_key = ?")
          .get(scopeId, key);
        if (!exists) {
          this.assertCapacity();
          const count = this.db
            .prepare("SELECT count(*) AS count FROM context_graph_commit WHERE scope_id = ?")
            .get(scopeId) as { count: number };
          if (count.count >= this.settings.maxContextCommits) throw new Error("Context commit quota exhausted");
        }
        const result = commit();
        this.checkRecord(result);
        return result;
      })
      .immediate();
  }

  /** 只枚举授权作用域内的版本入口，不自动读取历史正文 */
  contextRefs(scopeId: string): readonly { name: string; commitId: string; version: number }[] {
    return this.db
      .prepare(
        "SELECT name, commit_id AS commitId, version FROM context_graph_ref WHERE scope_id = ? ORDER BY updated_at DESC LIMIT 32"
      )
      .all(scopeId) as { name: string; commitId: string; version: number }[];
  }

  /** 模型提出下一次目标推进仍受同一授权、队列、速率与尝试上限限制 */
  advanceTask(grant: ExecutionGrant, input: { id: string; key: string; instruction: string }): ExecutionIntent {
    if (!this.settings.enabled) throw new Error("Autonomous execution disabled");
    this.checkText(input.instruction);
    this.authorize(grant.id, input.id);
    const eventId = `task:${input.id}:${input.key}`;
    const previous = this.getIntent(
      keyId("intent", [grant.source.platform, grant.source.channelId, grant.source.conversationId, eventId])
    );
    const event: SynapseChannelEvent = {
      id: eventId,
      platform: grant.source.platform as SynapseChannelEvent["platform"],
      channelId: grant.source.channelId,
      eventType: "task.wake",
      origin: "incoming",
      conversation: {
        id: grant.source.conversationId,
        kind: grant.source.conversationKind as SynapseChannelEvent["conversation"]["kind"]
      },
      sender: { id: grant.principalId },
      receivedAt: previous?.payload.event.receivedAt ?? new Date().toISOString(),
      message: textMessage(input.instruction)
    };
    const request: AgentRequest = {
      sessionId: grant.sessionId ?? "",
      workspaceId: grant.workspaceId,
      userId: grant.principalId,
      taskId: input.id,
      input: event.message!,
      source: grant.source,
      contextPolicy: { includeHistory: false, maxMessages: 0 },
      event
    };
    return this.accept({ key: event.id, grantId: grant.id, taskId: input.id, payload: { request, event } });
  }

  /** 确定发送失败后显式重试交付，引用原结果且不重新执行模型或工具 */
  retryDelivery(runId: string, key: string): ExecutionIntent {
    const original = this.forRun(runId);
    const result = this.result(runId);
    const run = this.runs.get(runId);
    if (
      !original ||
      !result ||
      !["reply", "notify"].includes(result.kind) ||
      run?.status !== "failed" ||
      !this.runs.latestEvent(runId, "response_send_failed")
    )
      throw new Error("Only confirmed delivery failure can retry");
    if (
      this.db
        .prepare("SELECT 1 FROM execution_operations WHERE run_id = ? AND state IN ('started','uncertain') LIMIT 1")
        .get(runId)
    )
      throw new Error("Uncertain operation requires reconciliation");
    const { scope: _scope, ...payload } = original.payload;
    return this.accept({
      key: `delivery-retry:${runId}:${key}`,
      grantId: original.grantId,
      payload: { ...payload, deliveryOfRunId: runId }
    });
  }

  /** 预览符合保留期限的派生记录，仅返回数量，不删除实际持久数据 */
  collectionPreview(now = Date.now()): { intents: number; observations: number } {
    const cutoff = now - this.settings.retentionHours * 3_600_000;
    const intents = this.db
      .prepare(
        "SELECT count(*) AS count FROM execution_intents WHERE state IN ('done','blocked') AND created_at < ? AND grant_id IN (SELECT id FROM execution_grants WHERE expires_at <= ? OR revoked = 1) AND run_id NOT IN (SELECT run_id FROM execution_operations WHERE state IN ('started','uncertain'))"
      )
      .get(cutoff, now) as { count: number };
    const observations = this.db
      .prepare("SELECT count(*) AS count FROM observed_inputs WHERE expires_at <= ?")
      .get(now) as { count: number };
    return { intents: intents.count, observations: observations.count };
  }

  /** 模型暂时故障仅在尚无工具、交付和结果时退避，决策与 Attempt 终止同事务提交 */
  retryModel(runId: string, attemptId: string, failure: ModelFailure, now = Date.now()): boolean {
    if (failure.kind !== "model" || !failure.retryable) return false;
    return this.db
      .transaction(() => {
        const intent = this.forRun(runId);
        if (
          !intent ||
          intent.state !== "claimed" ||
          intent.attempts >= this.settings.maxAttempts ||
          this.result(runId) ||
          this.runs.get(runId)?.status !== "running"
        )
          return false;
        try {
          this.validateIntent(intent, now);
        } catch {
          return false;
        }
        const usage = this.db.prepare("SELECT model_calls FROM execution_usage WHERE run_id = ?").get(runId) as
          | { model_calls: number }
          | undefined;
        if (
          (usage?.model_calls ?? 0) >= this.settings.maxModelCallsPerRun ||
          this.db.prepare("SELECT 1 FROM execution_operations WHERE run_id = ? LIMIT 1").get(runId) ||
          this.db
            .prepare(
              "SELECT 1 FROM run_events WHERE run_id = ? AND json_extract(record, '$.type') IN ('tool_call_started','response_sending','artifact_upload_started') LIMIT 1"
            )
            .get(runId)
        )
          return false;
        const delay = Math.min(
          this.settings.maxRetryDelayMs,
          this.settings.retryBaseDelayMs * 2 ** (intent.attempts - 1)
        );
        this.runs.append(runId, {
          key: `${attemptId}:retry`,
          type: "run_interrupted",
          status: "interrupted",
          phase: "retry",
          attemptId,
          error: {
            code: `model_${failure.code}_retry`,
            message: "模型服务暂时故障，已按执行预算安排重试",
            phase: "model"
          },
          data: { availableAt: now + delay, attempts: intent.attempts }
        });
        this.db
          .prepare("UPDATE execution_intents SET state = 'queued', next_attempt_at = ? WHERE id = ?")
          .run(now + delay, intent.id);
        return true;
      })
      .immediate();
  }

  /** 标记本轮调度结束，失败不自动完成或取消持久目标 */
  finish(id: string): void {
    const intent = this.getIntent(id);
    if (!intent || intent.state !== "claimed") return;
    const status = this.runs.get(intent.runId)?.status;
    const state =
      status === "uncertain" || status === "running"
        ? "blocked"
        : status === "accepted" || status === "interrupted"
          ? "queued"
          : "done";
    this.db.prepare("UPDATE execution_intents SET state = ? WHERE id = ? AND state = 'claimed'").run(state, id);
  }

  /** 重启只恢复无未知副作用的运行，保留逻辑 Run 并增加下次 Attempt */
  recover(): void {
    this.db
      .transaction(() => {
        const rows = this.db.prepare("SELECT id FROM execution_intents WHERE state IN ('queued','claimed')").all() as {
          id: string;
        }[];
        for (const row of rows) {
          const intent = this.getIntent(row.id)!;
          const run = this.runs.get(intent.runId);
          const unknown = this.db
            .prepare(
              "SELECT 1 FROM execution_operations WHERE run_id = ? AND (state = 'uncertain' OR (state = 'started' AND effect = 'external')) LIMIT 1"
            )
            .get(intent.runId);
          const state =
            unknown || run?.status === "uncertain"
              ? "blocked"
              : run && ["succeeded", "failed", "blocked"].includes(run.status)
                ? "done"
                : "queued";
          this.db.prepare("UPDATE execution_intents SET state = ? WHERE id = ?").run(state, row.id);
        }
      })
      .immediate();
  }

  /** 用同库权威回执补齐 Trace，已确认本地事务可续作，外部未知动作保持阻断 */
  reconcile(): void {
    const active = this.db
      .prepare("SELECT id FROM execution_intents WHERE state IN ('queued','claimed') ORDER BY ordinal LIMIT ?")
      .all(this.settings.maxPendingIntents) as { id: string }[];
    for (const row of active) {
      const intent = this.getIntent(row.id)!;
      const run = this.runs.get(intent.runId);
      if (!run || !["accepted", "running"].includes(run.status)) continue;
      const append = (key: string, type: Parameters<RunTraceStore["append"]>[1]["type"], data: unknown) => {
        if (this.db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND event_key = ?").get(intent.runId, key))
          return;
        this.runs.append(intent.runId, { key, type, data });
      };
      const operations = this.db
        .prepare("SELECT id FROM execution_operations WHERE run_id = ? ORDER BY created_at LIMIT ?")
        .all(intent.runId, this.settings.maxToolCallsPerRun + 1) as { id: string }[];
      for (const item of operations) {
        let operation = this.operation(item.id)!;
        if (operation.state === "started") {
          const receipt = this.db
            .prepare("SELECT payload_json FROM line_events WHERE idempotency_key = ? LIMIT 1")
            .get(`tool:${item.id}:tool_call_succeeded`) as { payload_json: string } | undefined;
          const payload = receipt
            ? (decodeJson(receipt.payload_json, "operation receipt") as Record<string, unknown>)
            : undefined;
          if (payload?.name === operation.name && isDeepStrictEqual(payload.input, operation.input)) {
            this.receipt(item.id, "succeeded", payload.output ?? null);
            operation = this.operation(item.id)!;
          }
        }
        if (operation.name === "delivery") {
          if (operation.state === "succeeded")
            append(`operation-receipt:${item.id}`, "response_sent", operation.result);
          else if (operation.state === "failed")
            append(`operation-receipt:${item.id}`, "response_send_failed", operation.result);
          continue;
        }
        if (operation.state === "started" && operation.effect === "external") continue;
        if (operation.state === "uncertain") continue;
        const type =
          operation.state === "succeeded"
            ? "tool_call_succeeded"
            : operation.state === "blocked"
              ? "tool_call_blocked"
              : "tool_call_failed";
        append(`operation-receipt:${item.id}`, type, {
          callId: item.id,
          name: operation.name,
          input: operation.input,
          ...(operation.state === "succeeded"
            ? { output: operation.result }
            : { error: operation.result ?? { message: "Local transaction was not committed" } })
        });
      }
      const outcome = this.result(intent.runId);
      if (outcome?.kind === "silent" || outcome?.kind === "waiting")
        append("outcome-receipt", "execution_completed", { kind: outcome.kind });
    }
  }

  /** 模型只创建自己授权域内的目标，父子深度和数量有硬上限 */
  createTask(grant: ExecutionGrant, input: { key: string; goal: string; acceptance: string; parentId?: string }): Task {
    this.authorize(grant.id);
    this.checkText(input.goal);
    this.checkText(input.acceptance);
    return this.db
      .transaction(() => {
        const id = keyId("task", [grant.workspaceId, grant.principalId, input.key]);
        const previous = this.db.prepare("SELECT creation_request, record FROM agent_tasks WHERE id = ?").get(id) as
          | (Row & { creation_request: string })
          | undefined;
        if (previous) {
          if (previous.creation_request !== stable(input)) throw new Error("Task creation conflict");
          return unpack<Task>(previous)!;
        }
        this.assertCapacity();
        const count = this.db
          .prepare("SELECT count(*) AS count FROM agent_tasks WHERE workspace_id = ?")
          .get(grant.workspaceId) as { count: number };
        if (count.count >= this.settings.maxTasks) throw new Error("Task quota exhausted");
        let parentId = input.parentId;
        let depth = 1;
        while (parentId) {
          if (++depth > this.settings.maxTaskDepth) throw new Error("Task depth exhausted");
          parentId = this.getTask(parentId, grant).parentId;
        }
        const task: Task = {
          id,
          workspaceId: grant.workspaceId,
          principalId: grant.principalId,
          goal: input.goal,
          acceptance: input.acceptance,
          status: "open",
          revision: 1,
          progress: "",
          results: [],
          ...(input.parentId ? { parentId: input.parentId } : {})
        };
        this.db
          .prepare("INSERT INTO agent_tasks VALUES (?, ?, ?, ?, 1, 'open', ?, ?, ?)")
          .run(id, task.workspaceId, task.principalId, input.parentId ?? null, input.key, stable(input), stable(task));
        return task;
      })
      .immediate();
  }

  /** 默认目标归属主体私有，共享工作区不隐式分享目标内容 */
  getTask(id: string, grant: ExecutionGrant): Task {
    const task = unpack<Task>(
      this.db
        .prepare("SELECT record FROM agent_tasks WHERE id = ? AND workspace_id = ? AND principal_id = ?")
        .get(id, grant.workspaceId, grant.principalId) as Row | undefined
    );
    if (!task) throw new Error("Task not found or unauthorized");
    return task;
  }

  /** 有界列出当前主体的目标 */
  readTask(runId: string, id: string): Task {
    const intent = this.forRun(runId);
    if (!intent) throw new Error("Execution intent missing");
    const grant = this.authorize(intent.grantId);
    const task = this.getTask(id, grant);
    if (intent.taskId === id && task.status === "open")
      this.db
        .prepare("UPDATE execution_intents SET record = ? WHERE id = ?")
        .run(this.serializeIntent({ ...intent, taskRevision: task.revision }), intent.id);
    return task;
  }

  /** 有界列出当前主体的目标 */
  listTasks(grant: ExecutionGrant): readonly Task[] {
    this.authorize(grant.id);
    return (
      this.db
        .prepare(
          "SELECT record FROM agent_tasks WHERE workspace_id = ? AND principal_id = ? ORDER BY rowid DESC LIMIT ?"
        )
        .all(grant.workspaceId, grant.principalId, this.settings.maxTasks) as Row[]
    ).map((row) => unpack<Task>(row)!);
  }

  /** 已鉴权管理端按工作区检查持久目标，模型工具不暴露此全局入口 */
  inspectTasks(workspaceId?: string): readonly Task[] {
    return (
      this.db
        .prepare(
          `SELECT record FROM agent_tasks ${workspaceId ? "WHERE workspace_id = ?" : ""} ORDER BY rowid DESC LIMIT 200`
        )
        .all(...(workspaceId ? [workspaceId] : [])) as Row[]
    ).map((row) => unpack<Task>(row)!);
  }

  /** 已鉴权管理端按身份读取单个目标 */
  inspectTask(id: string): Task | undefined {
    return unpack<Task>(this.db.prepare("SELECT record FROM agent_tasks WHERE id = ?").get(id) as Row | undefined);
  }

  /** 用户显式控制目标状态仍须检查 revision，不依赖目标原授权是否过期 */
  controlTask(id: string, expectedRevision: number, status: "open" | "paused" | "cancelled"): Task {
    return this.db
      .transaction(() => {
        const task = this.inspectTask(id);
        if (!task) throw new Error("Task not found");
        if (task.revision !== expectedRevision) throw new Error("Task revision conflict");
        if (["completed", "cancelled"].includes(task.status)) throw new Error("Task is terminal");
        if (!["open", "paused", "cancelled"].includes(status)) throw new Error("Invalid task status");
        const next = { ...task, status, revision: task.revision + 1 };
        this.db
          .prepare("UPDATE agent_tasks SET status = ?, revision = ?, record = ? WHERE id = ? AND revision = ?")
          .run(status, next.revision, stable(next), id, expectedRevision);
        return next;
      })
      .immediate();
  }

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
    this.authorize(grant.id);
    this.checkRecord(input);
    if (
      [input.goal, input.acceptance, input.status, input.progress, input.result].every((value) => value === undefined)
    )
      throw new Error("Task update requires a change");
    if (input.goal !== undefined) this.checkText(input.goal);
    if (input.acceptance !== undefined) this.checkText(input.acceptance);
    if (input.status !== undefined && !["open", "paused", "completed", "cancelled"].includes(input.status))
      throw new Error("Invalid task status");
    return this.db
      .transaction(() => {
        const current = this.getTask(input.id, grant);
        if (
          input.status === "completed" &&
          (!input.result || input.goal !== undefined || input.acceptance !== undefined)
        )
          throw new Error("Completion requires current revision evidence");
        if (input.result) {
          const execution = this.forRun(input.result.runId);
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
        this.checkRecord(task);
        this.db
          .prepare("UPDATE agent_tasks SET revision = ?, status = ?, record = ? WHERE id = ? AND revision = ?")
          .run(task.revision, task.status, stable(task), task.id, current.revision);
        return { task, conflict };
      })
      .immediate();
  }

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
    if (!this.settings.enabled) throw new Error("Autonomous scheduling disabled");
    this.authorize(grant.id, input.taskId, now);
    this.checkText(input.instruction);
    return this.db
      .transaction(() => {
        const id = keyId("schedule", [grant.id, input.key]);
        const previous = this.db
          .prepare("SELECT record, creation_request FROM agent_schedules WHERE id = ?")
          .get(id) as (Row & { creation_request: string }) | undefined;
        if (previous) {
          if (previous.creation_request !== stable(input)) throw new Error("Schedule creation conflict");
          return unpack<Schedule>(previous)!;
        }
        this.assertCapacity();
        const count = this.db
          .prepare("SELECT count(*) AS count FROM agent_schedules WHERE workspace_id = ?")
          .get(grant.workspaceId) as { count: number };
        if (count.count >= this.settings.maxSchedules) throw new Error("Schedule quota exhausted");
        if (input.rule.kind === "interval" && input.rule.everyMs < this.settings.minScheduleIntervalMs)
          throw new Error("Schedule interval below host minimum");
        const nextFireAt = nextScheduleTime(input.rule, now);
        const expiresAt = Math.min(
          input.expiresAt ?? Infinity,
          grant.expiresAt,
          now + this.settings.maxScheduleLifetimeHours * 3_600_000
        );
        const maxOccurrences = input.maxOccurrences ?? this.settings.maxScheduleOccurrences;
        if (
          !nextFireAt ||
          nextFireAt >= expiresAt ||
          !Number.isInteger(maxOccurrences) ||
          maxOccurrences < 1 ||
          maxOccurrences > this.settings.maxScheduleOccurrences
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
        this.db
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
  }

  /** 读取计划快照，调用方必须先验证所属授权 */
  schedule(id: string): Schedule | undefined {
    return unpack(this.db.prepare("SELECT record FROM agent_schedules WHERE id = ?").get(id) as Row | undefined);
  }

  /** 主体只能列出自己创建的计划 */
  listSchedules(grant: ExecutionGrant): readonly Schedule[] {
    this.authorize(grant.id);
    return (
      this.db
        .prepare(
          "SELECT s.record FROM agent_schedules s JOIN execution_grants g ON g.id = s.grant_id WHERE s.workspace_id = ? AND g.principal_id = ? ORDER BY s.rowid DESC LIMIT ?"
        )
        .all(grant.workspaceId, grant.principalId, this.settings.maxSchedules) as Row[]
    ).map((row) => unpack<Schedule>(row)!);
  }

  /** 修改、暂停与取消均增加修订，不复活已产生的旧 occurrence */
  updateSchedule(
    grant: ExecutionGrant,
    id: string,
    expectedRevision: number,
    patch: { status?: "active" | "paused" | "cancelled"; instruction?: string; rule?: ScheduleRule },
    now = Date.now()
  ): Schedule {
    this.authorize(grant.id, undefined, now);
    this.checkRecord(patch);
    if ([patch.status, patch.instruction, patch.rule].every((value) => value === undefined))
      throw new Error("Schedule update requires a change");
    if (patch.instruction !== undefined) this.checkText(patch.instruction);
    if (patch.status !== undefined && !["active", "paused", "cancelled"].includes(patch.status))
      throw new Error("Invalid schedule status");
    return this.db
      .transaction(() => {
        const current = this.schedule(id);
        const owner = current && this.getGrant(current.grantId);
        if (!current || owner?.workspaceId !== grant.workspaceId || owner.principalId !== grant.principalId)
          throw new Error("Schedule unauthorized");
        if (current.revision !== expectedRevision) throw new Error("Schedule revision conflict");
        if (current.status === "cancelled" || (current.status === "completed" && patch.status !== "cancelled"))
          throw new Error("Schedule terminal");
        const rule = patch.rule ?? current.rule;
        if (rule.kind === "interval" && rule.everyMs < this.settings.minScheduleIntervalMs)
          throw new Error("Schedule interval below host minimum");
        const next = patch.rule || patch.status === "active" ? nextScheduleTime(rule, now) : current.nextFireAt;
        if (!next || next >= current.expiresAt) throw new Error("Schedule expired");
        const schedule: Schedule = { ...current, ...patch, rule, nextFireAt: next, revision: current.revision + 1 };
        this.writeSchedule(schedule);
        return schedule;
      })
      .immediate();
  }

  /** 到期事实、标准 Intent 和 nextFireAt 原子提交，重启不能重复领取同一时刻 */
  tick(now = Date.now()): number {
    if (!this.settings.enabled) return 0;
    const due = this.db
      .prepare(
        "SELECT record FROM agent_schedules WHERE status = 'active' AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 100"
      )
      .all(now) as Row[];
    let count = 0;
    for (const row of due) {
      try {
        this.db
          .transaction(() => {
            const candidate = unpack<Schedule>(row)!;
            const schedule = this.schedule(candidate.id)!;
            if (schedule.status !== "active" || schedule.nextFireAt > now) return;
            let grant: ExecutionGrant;
            try {
              grant = this.authorize(schedule.grantId, schedule.taskId, now);
            } catch {
              this.writeSchedule({ ...schedule, status: "cancelled" });
              return;
            }
            if (schedule.expiresAt <= now || schedule.fired >= schedule.maxOccurrences) {
              this.writeSchedule({ ...schedule, status: "completed" });
              return;
            }
            const overlap = this.db
              .prepare(
                "SELECT 1 FROM execution_intents WHERE schedule_id = ? AND state IN ('queued','claimed') LIMIT 1"
              )
              .get(schedule.id);
            const missed = schedule.missed === "skip" && now - schedule.nextFireAt > this.settings.pollIntervalMs * 2;
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
              const intent = this.accept(
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
            this.db
              .prepare("INSERT INTO schedule_occurrences VALUES (?, ?, ?, ?, ?, ?)")
              .run(schedule.id, schedule.revision, schedule.nextFireAt, intentId, skip ? "skipped" : "accepted", now);
            const next = nextScheduleTime(schedule.rule, now);
            const fired = schedule.fired + 1;
            this.writeSchedule({
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
          this.writeSchedule({ ...schedule, status: "completed", stopReason: "grant_budget" });
        }
      }
    }
    return count;
  }

  /** 补充信息先落持久 Inbox，消费确认独立于模型 HTTP 请求 */
  enqueueInput(runId: string, eventKey: string, content: string): void {
    this.checkText(content);
    const intent = this.forRun(runId);
    if (!intent || !["queued", "claimed"].includes(intent.state)) throw new Error("Run is not accepting input");
    const prior = this.db
      .prepare("SELECT content FROM execution_inbox WHERE run_id = ? AND event_key = ?")
      .get(runId, eventKey) as { content: string } | undefined;
    if (prior && prior.content !== content) throw new Error("Inbox identity conflict");
    if (prior) return;
    const count = this.db.prepare("SELECT count(*) AS count FROM execution_inbox WHERE run_id = ?").get(runId) as {
      count: number;
    };
    if (count.count >= 64) throw new Error("Inbox quota exhausted");
    this.db
      .prepare("INSERT INTO execution_inbox(run_id,event_key,content,created_at) VALUES (?, ?, ?, ?)")
      .run(runId, eventKey, content, Date.now());
  }

  /** 安全边界消费有界信息，恢复后仍可通过全部输入重建本轮上下文 */
  inputs(runId: string, all = false): readonly { id: number; content: string }[] {
    return this.db
      .prepare(
        `SELECT ordinal AS id, content FROM execution_inbox WHERE run_id = ? ${all ? "" : "AND consumed = 0"} ORDER BY ordinal LIMIT 64`
      )
      .all(runId) as { id: number; content: string }[];
  }

  /** 仅在输入确实加入下一模型请求后确认消费 */
  acknowledgeInputs(runId: string, through: number): void {
    this.db.prepare("UPDATE execution_inbox SET consumed = 1 WHERE run_id = ? AND ordinal <= ?").run(runId, through);
  }

  /** 未触发输入采用单独短期保留，不创建 Run、Task 或 Context Commit */
  observe(
    input: { id: string; sessionId: string; principalId: string; contextEligible: boolean; event: SynapseChannelEvent },
    now = Date.now()
  ): void {
    this.checkRecord(input.event);
    this.assertCapacity();
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM observed_inputs WHERE expires_at <= ?").run(now);
        this.db
          .prepare("INSERT OR IGNORE INTO observed_inputs VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            keyId("observation", [input.sessionId, input.id]),
            input.sessionId,
            input.principalId,
            input.contextEligible ? 1 : 0,
            now + this.settings.observationTtlMinutes * 60_000,
            now,
            stable(input.event)
          );
        this.db
          .prepare(
            "DELETE FROM observed_inputs WHERE session_id = ? AND id NOT IN (SELECT id FROM observed_inputs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)"
          )
          .run(input.sessionId, input.sessionId, this.settings.maxObservationsPerSession);
      })
      .immediate();
  }

  /** 只在当前会话授权范围读取短期观察，不因共享工作区跨会话检索 */
  observations(sessionId: string, now = Date.now()): readonly SynapseChannelEvent[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM observed_inputs WHERE session_id = ? AND context_eligible = 1 AND expires_at > ? ORDER BY created_at DESC LIMIT ?"
        )
        .all(sessionId, now, this.settings.maxObservationsPerSession) as Row[]
    )
      .reverse()
      .map((row) => unpack<SynapseChannelEvent>(row)!);
  }

  /** 开始副作用前保存稳定操作身份，未知结果不得作为缺失重放 */
  startOperation(
    runId: string,
    id: string,
    name: string,
    input: unknown,
    effect: "external" | "transactional" | "read" = "external"
  ): void {
    this.checkRecord(input);
    const existing = this.db
      .prepare("SELECT run_id, name, input, state, effect FROM execution_operations WHERE id = ?")
      .get(id) as { run_id: string; name: string; input: string; state: string; effect: string } | undefined;
    if (existing) {
      if (existing.run_id !== runId || existing.name !== name || existing.input !== stable(input))
        throw new Error("Operation identity conflict");
      if (existing.state === "started" && existing.effect === effect && effect !== "external") return;
      throw new Error("Operation already exists; reconcile before executing");
    }
    this.db
      .prepare("INSERT INTO execution_operations VALUES (?, ?, ?, ?, ?, 'started', NULL, ?)")
      .run(id, runId, name, stable(input), effect, Date.now());
  }

  /** 本地工具的变更与回执同事务提交，没有回执即没有已提交的本地变更 */
  transactionalTool(id: string, execute: () => unknown): unknown {
    return this.db
      .transaction(() => {
        const operation = this.operation(id);
        if (!operation || operation.effect === "external") throw new Error("Transactional operation required");
        const result = execute();
        if (result && typeof result === "object" && "then" in result)
          throw new Error("Async work is forbidden in a database transaction");
        this.receipt(id, "succeeded", result ?? null);
        return result;
      })
      .immediate();
  }

  /** 单 Run 的模型与工具额度跨 Attempt 累计，重启不会重置资源预算 */
  consume(runId: string, kind: "model" | "tool"): void {
    this.assertCapacity();
    if (this.result(runId)) throw new Error("Execution outcome already committed");
    this.db
      .transaction(() => {
        this.db.prepare("INSERT OR IGNORE INTO execution_usage(run_id) VALUES (?)").run(runId);
        const usage = this.db
          .prepare("SELECT model_calls, tool_calls FROM execution_usage WHERE run_id = ?")
          .get(runId) as { model_calls: number; tool_calls: number };
        if (
          kind === "model"
            ? usage.model_calls >= this.settings.maxModelCallsPerRun
            : usage.tool_calls >= this.settings.maxToolCallsPerRun
        )
          throw new Error(`Run ${kind} budget exhausted`);
        this.db
          .prepare(
            kind === "model"
              ? "UPDATE execution_usage SET model_calls = model_calls + 1 WHERE run_id = ?"
              : "UPDATE execution_usage SET tool_calls = tool_calls + 1 WHERE run_id = ?"
          )
          .run(runId);
      })
      .immediate();
  }

  /** 保存确定回执；超时或中断作为未知事实，不假定外部动作失败 */
  receipt(id: string, state: "succeeded" | "failed" | "blocked" | "uncertain", result: unknown): void {
    this.checkRecord(result);
    const row = this.db.prepare("SELECT state, result FROM execution_operations WHERE id = ?").get(id) as
      | { state: string; result: string | null }
      | undefined;
    if (!row) throw new Error("Operation not found");
    if (!["started", "uncertain"].includes(row.state)) {
      if (row.state !== state || row.result !== stable(result)) throw new Error("Receipt conflict");
      return;
    }
    this.db
      .prepare("UPDATE execution_operations SET state = ?, result = ? WHERE id = ?")
      .run(state, stable(result), id);
  }

  /** 精确索引读取操作与回执，不扫描整条会话日志 */
  operation(id: string):
    | {
        runId: string;
        name: string;
        input: unknown;
        state: string;
        effect: "external" | "transactional" | "read";
        result: unknown;
      }
    | undefined {
    const row = this.db
      .prepare("SELECT run_id, name, input, state, effect, result FROM execution_operations WHERE id = ?")
      .get(id) as
      | {
          run_id: string;
          name: string;
          input: string;
          state: string;
          effect: "external" | "transactional" | "read";
          result: string | null;
        }
      | undefined;
    return row
      ? {
          runId: row.run_id,
          name: row.name,
          input: JSON.parse(row.input),
          state: row.state,
          effect: row.effect,
          result: row.result ? JSON.parse(row.result) : null
        }
      : undefined;
  }

  /** 宿主显式清理失效授权的过期派生记录，保留有效授权计数和未决动作 */
  collect(confirmation: "delete-expired-derived-execution-records", now = Date.now()): void {
    if (confirmation !== "delete-expired-derived-execution-records")
      throw new Error("Explicit retention confirmation required");
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM observed_inputs WHERE expires_at <= ?").run(now);
        const cutoff = now - this.settings.retentionHours * 3_600_000;
        const rows = this.db
          .prepare(
            "SELECT id, run_id FROM execution_intents WHERE state IN ('done','blocked') AND created_at < ? AND grant_id IN (SELECT id FROM execution_grants WHERE expires_at <= ? OR revoked = 1) AND run_id NOT IN (SELECT run_id FROM execution_operations WHERE state IN ('started','uncertain')) LIMIT 100"
          )
          .all(cutoff, now) as { id: string; run_id: string }[];
        for (const row of rows) {
          this.db.prepare("DELETE FROM schedule_occurrences WHERE intent_id = ?").run(row.id);
          this.db.prepare("DELETE FROM execution_inbox WHERE run_id = ?").run(row.run_id);
          this.db.prepare("DELETE FROM execution_results WHERE run_id = ?").run(row.run_id);
          this.db.prepare("DELETE FROM execution_operations WHERE run_id = ?").run(row.run_id);
          this.db.prepare("DELETE FROM execution_intents WHERE id = ?").run(row.id);
        }
        // 清理仅释放页供 SQLite 复用，不在运行期间执行全库 VACUUM
      })
      .immediate();
  }

  private serializeIntent(intent: ExecutionIntent): string {
    const { input, event: _requestEvent, ...request } = intent.payload.request;
    const { message: _message, ...event } = intent.payload.event;
    const { scope, request: _request, event: _event, ...rest } = intent.payload;
    const stored: StoredIntent = {
      ...intent,
      format: 1,
      payload: {
        ...rest,
        request,
        event,
        ...(scope ? { scope: { provider: scope.provider, eventId: scope.accepted.event.id } } : { input })
      }
    };
    this.checkRecord(stored);
    return stable(stored);
  }

  private checkRecord(value: unknown): void {
    const serialized = stable(value);
    if (!serialized || serialized.length > this.settings.maxRecordChars)
      throw new Error("Execution record exceeds host budget");
  }

  private checkText(value: string): void {
    if (typeof value !== "string" || !value.trim() || value.length > this.settings.maxRecordChars)
      throw new Error("Invalid execution content");
  }

  private writeSchedule(schedule: Schedule): void {
    this.db
      .prepare("UPDATE agent_schedules SET revision = ?, status = ?, next_fire_at = ?, record = ? WHERE id = ?")
      .run(schedule.revision, schedule.status, schedule.nextFireAt, stable(schedule), schedule.id);
  }

  private blockRun(runId: string, reason: string): void {
    const run = this.runs.get(runId);
    if (run && ["accepted", "running", "interrupted"].includes(run.status)) {
      if (run.status === "interrupted")
        this.runs.append(runId, { key: `blocked-resume:${randomUUID()}`, type: "run_resumed", status: "running" });
      this.runs.append(runId, {
        key: `blocked:${reason}`,
        type: "run_blocked",
        status: "blocked",
        error: { code: reason, message: reason, phase: "admission" }
      });
    }
  }
}

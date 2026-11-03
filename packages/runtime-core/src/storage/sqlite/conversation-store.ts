import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type AcceptNormalizedEventInput,
  type AcceptedNormalizedEvent,
  type AppendLineEventInput,
  type BranchContext,
  type BranchPublication,
  type BranchResult,
  type BranchResultTrace,
  type ConversationBranch,
  type ConversationLine,
  type ConversationMainline,
  type ConversationRecoveryState,
  type ConversationSession,
  type ConversationSessionLocator,
  type CreateBranchInput,
  type CreateBranchResultInput,
  type CreateSessionInput,
  type EventTrace,
  type LineEvent,
  type LineEventType,
  type ListBranchesOptions,
  type ListLineEventsOptions,
  type ListLinesOptions,
  type NormalizedEvent,
  type PublishBranchResultInput,
  type TransitionBranchInput,
  type TransitionSessionInput
} from "../../conversation/types.js";
import type { ConversationStore } from "../../conversation/store.js";
import { ConversationStoreError } from "../../conversation/errors.js";
import { collectRelatedEvents } from "../../conversation/trace.js";
import {
  assertBranchCanCreateResult,
  assertWritableSession,
  invalidTransition,
  isBranchTransitionAllowed,
  SESSION_ARCHIVABLE_BRANCH_STATUSES
} from "../../conversation/rules.js";
import { decodeJson, encodeOptionalJson, encodeRequiredJson, jsonValuesEqual } from "./json-codec.js";
import type {
  LineEventRow,
  LineRow,
  MergeRow,
  NormalizedEventRow,
  ResultRow,
  SessionRow
} from "./conversation-rows.js";

const LOCATOR_TYPES = new Set(["private", "group", "channel", "cli", "system"]);

/**
 * 会话存储的 SQLite 实现
 *
 * 仓储借用传入连接且不负责迁移和关闭以便与其他上下文仓储共享事务边界
 */
export class SqliteConversationRepository implements ConversationStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#db.pragma("foreign_keys = ON");
  }

  async acceptNormalizedEvent(input: AcceptNormalizedEventInput): Promise<AcceptedNormalizedEvent> {
    return this.acceptNormalizedEventSync(input);
  }

  /** 供同库输入与执行意图用例组合短事务，返回前不跨越异步边界 */
  acceptNormalizedEventSync(input: AcceptNormalizedEventInput): AcceptedNormalizedEvent {
    validateNormalizedEventInput(input);
    const segments = input.segments ?? input.message?.segments ?? [];
    encodeRequiredJson(segments, "normalized event segments");
    encodeOptionalJson(input.message, "normalized event message");
    encodeOptionalJson(input.triggerHint, "normalized event trigger hint");
    encodeOptionalJson(input.rawPayload, "normalized event raw payload");
    encodeOptionalJson(input.sessionMetadata, "session metadata");

    return this.#write(() => {
      const existing = this.#getNormalizedEventByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) {
        this.#assertNormalizedEventRetry(existing, input, segments);
        const session = this.#requireSession(existing.sessionId);
        const mainline = this.#requireMainline(existing.sessionId);
        const lineEvent = this.#requireEvent(existing.lineEventId);
        return { event: existing, lineEvent, session, mainline, created: false };
      }

      const duplicateSource = this.#db
        .prepare(`
          SELECT idempotency_key
          FROM normalized_events
          WHERE platform = ?
            AND provider = ?
            AND channel_id = ?
            AND source_event_id = ?
            AND source_event_type = ?
          LIMIT 1
        `)
        .get(input.platform, input.provider, input.channelId, input.sourceEventId, input.sourceEventType) as
        | { readonly idempotency_key: string }
        | undefined;
      if (duplicateSource !== undefined) {
        throw new ConversationStoreError(
          "idempotency_conflict",
          `Normalized source event "${input.sourceEventId}" was already accepted with another request.`
        );
      }

      const session = this.#createOrEnsureSession(
        {
          id: input.sessionId,
          locator: {
            platform: input.platform,
            provider: input.provider,
            channelId: input.channelId,
            conversationType: input.conversationType,
            conversationId: input.conversationId
          },
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.sessionMetadata === undefined ? {} : { metadata: input.sessionMetadata }),
          createdAt: input.receivedAt
        },
        true
      );
      const mainline = this.#requireMainline(session.id);
      const targetLine = this.#requireLine(input.targetLineId ?? mainline.id);
      if (targetLine.sessionId !== session.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Line "${targetLine.id}" does not belong to session "${session.id}".`
        );
      }

      const normalizedEventId = input.id ?? `normalized-event:${randomUUID()}`;
      const lineEventId = input.lineEventId ?? `line-event:${randomUUID()}`;
      this.#assertUnusedNormalizedEventId(normalizedEventId);
      this.#assertUnusedLineEventId(lineEventId);
      const acceptedAt = new Date().toISOString();

      this.#db
        .prepare(`
          INSERT INTO normalized_events (
            id,
            session_id,
            platform,
            provider,
            channel_id,
            conversation_type,
            conversation_id,
            source_event_id,
            source_message_id,
            source_event_type,
            sender_id,
            text,
            message_json,
            segments_json,
            trigger_hint_json,
            raw_payload_json,
            received_at,
            ingested_at,
            idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          normalizedEventId,
          session.id,
          input.platform,
          input.provider,
          input.channelId,
          input.conversationType,
          input.conversationId,
          input.sourceEventId,
          input.sourceMessageId ?? null,
          input.sourceEventType,
          input.senderId,
          input.text,
          encodeOptionalJson(input.message, "normalized event message"),
          encodeRequiredJson(segments, "normalized event segments"),
          encodeOptionalJson(input.triggerHint, "normalized event trigger hint"),
          encodeOptionalJson(input.rawPayload, "normalized event raw payload"),
          input.receivedAt,
          acceptedAt,
          input.idempotencyKey
        );

      const lineEvent = this.#appendLineEvent(targetLine, {
        id: lineEventId,
        sessionId: session.id,
        type: input.lineEventType ?? "user_message",
        idempotencyKey: `normalized:${input.idempotencyKey}`,
        sourceNormalizedEventId: normalizedEventId,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        payload: {
          normalizedEventId,
          text: input.text,
          ...(input.message === undefined ? {} : { message: input.message }),
          segments,
          ...(input.triggerHint === undefined ? {} : { triggerHint: input.triggerHint })
        },
        createdAt: input.receivedAt
      });
      const event = this.#requireNormalizedEvent(normalizedEventId);
      return { event, lineEvent, session, mainline, created: true };
    });
  }

  async getNormalizedEvent(eventId: string): Promise<NormalizedEvent | undefined> {
    validateId(eventId, "normalized event id");
    return this.#getNormalizedEvent(eventId);
  }

  /** 从规范事实精确恢复执行作用域，不复制输入正文到调度记录 */
  readAcceptedEvent(eventId: string): AcceptedNormalizedEvent {
    const event = this.#requireNormalizedEvent(eventId);
    return {
      event,
      session: this.#requireSession(event.sessionId),
      mainline: this.#requireMainline(event.sessionId),
      lineEvent: this.#requireEvent(event.lineEventId),
      created: true
    };
  }

  async listNormalizedEvents(sessionId: string): Promise<readonly NormalizedEvent[]> {
    validateId(sessionId, "session id");
    if (this.#getSession(sessionId) === undefined) {
      throw new ConversationStoreError("not_found", `Session "${sessionId}" does not exist.`);
    }
    const rows = this.#db
      .prepare(`
        SELECT
          normalized_events.*,
          line_events.line_id,
          line_events.id AS line_event_id
        FROM normalized_events
        JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.session_id = ?
        ORDER BY normalized_events.received_at, normalized_events.ingested_at, normalized_events.rowid
      `)
      .all(sessionId) as NormalizedEventRow[];
    return rows.map(normalizedEventFromRow);
  }

  async createSession(input: CreateSessionInput): Promise<ConversationSession> {
    return this.createSessionSync(input);
  }

  /** 会话创建用例在同库短事务中复用相同校验与幂等契约 */
  createSessionSync(input: CreateSessionInput): ConversationSession {
    validateCreateSessionInput(input);
    encodeOptionalJson(input.metadata, "session metadata");
    return this.#write(() => this.#createOrEnsureSession(input, true));
  }

  async ensureSession(input: CreateSessionInput): Promise<ConversationSession> {
    validateCreateSessionInput(input);
    encodeOptionalJson(input.metadata, "session metadata");
    return this.#write(() => this.#createOrEnsureSession(input, true));
  }

  async getSession(sessionId: string): Promise<ConversationSession | undefined> {
    validateId(sessionId, "session id");
    return this.#getSession(sessionId);
  }

  async transitionSession(sessionId: string, input: TransitionSessionInput): Promise<ConversationSession> {
    validateId(sessionId, "session id");
    validateId(input.idempotencyKey, "idempotency key");
    validateTimestamp(input.createdAt, "createdAt");

    return this.#write(() => {
      const session = this.#requireSession(sessionId);
      const mainline = this.#requireMainline(sessionId);
      const internalKey = `internal:session-status:${input.idempotencyKey}`;
      const existingEvent = this.#getEventByLineAndRequest(mainline.id, internalKey);
      if (existingEvent !== undefined) {
        assertTransitionEventRequest(existingEvent, "session_status_changed", input.status, undefined, input.createdAt);
        return { ...session, status: input.status, updatedAt: existingEvent.createdAt };
      }

      if (session.status !== "active" || input.status !== "archived") {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Session "${sessionId}" cannot transition from "${session.status}" to "${input.status}".`
        );
      }
      this.#assertSessionCanArchive(session.id);

      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#appendLineEvent(mainline, {
        type: "session_status_changed",
        idempotencyKey: internalKey,
        payload: { fromStatus: session.status, toStatus: input.status },
        createdAt
      });
      this.#db
        .prepare("UPDATE conversation_sessions SET status = ?, updated_at = ? WHERE id = ?")
        .run(input.status, createdAt, sessionId);
      this.#db
        .prepare("UPDATE conversation_lines SET status = ?, updated_at = ? WHERE id = ?")
        .run(input.status, createdAt, mainline.id);
      return this.#requireSession(sessionId);
    });
  }

  async getLine(lineId: string): Promise<ConversationLine | undefined> {
    validateId(lineId, "line id");
    return this.#getLine(lineId);
  }

  async getMainline(sessionId: string): Promise<ConversationMainline> {
    validateId(sessionId, "session id");
    return this.#requireMainline(sessionId);
  }

  async listLines(sessionId: string, options: ListLinesOptions = {}): Promise<readonly ConversationLine[]> {
    validateId(sessionId, "session id");
    this.#requireSession(sessionId);
    const clauses = ["session_id = ?"];
    const values: unknown[] = [sessionId];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      values.push(options.kind);
    }
    if (options.statuses !== undefined) {
      if (options.statuses.length === 0) {
        return [];
      }
      clauses.push(`status IN (${placeholders(options.statuses.length)})`);
      values.push(...options.statuses);
    }
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM conversation_lines
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE kind WHEN 'mainline' THEN 0 ELSE 1 END, created_at, id
      `)
      .all(...values) as LineRow[];
    return rows.map(lineFromRow);
  }

  async createBranch(input: CreateBranchInput): Promise<ConversationBranch> {
    validateCreateBranchInput(input);
    encodeOptionalJson(input.contextSnapshot, "branch context snapshot");

    return this.#write(() => {
      const existingRow = this.#db
        .prepare(`
          SELECT *
          FROM conversation_lines
          WHERE session_id = ?
            AND kind = 'branch'
            AND create_request_id = ?
          LIMIT 1
        `)
        .get(input.sessionId, input.idempotencyKey) as LineRow | undefined;
      if (existingRow !== undefined) {
        const existing = requireBranchFromRow(existingRow);
        this.#assertBranchCreateRetry(existing, input);
        return branchCreationSnapshot(existing);
      }

      const session = this.#requireSession(input.sessionId);
      assertWritableSession(session);
      const defaultMainline = this.#requireMainline(session.id);
      const parent = this.#requireMainlineById(input.parentMainlineId ?? defaultMainline.id);
      if (parent.sessionId !== session.id || parent.id !== defaultMainline.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Mainline "${parent.id}" is not the default mainline for session "${session.id}".`
        );
      }
      const sourceEvent = this.#requireEvent(input.sourceEventId);
      if (sourceEvent.sessionId !== session.id || sourceEvent.lineId !== parent.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Source event "${sourceEvent.id}" must belong to mainline "${parent.id}" in session "${session.id}".`
        );
      }

      const branchId = input.id ?? `branch-${randomUUID()}`;
      if (this.#getLine(branchId) !== undefined) {
        throw new ConversationStoreError("conflict", `Conversation line "${branchId}" already exists.`);
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#db
        .prepare(`
          INSERT INTO conversation_lines (
            id,
            session_id,
            kind,
            status,
            parent_mainline_id,
            source_line_event_id,
            create_request_id,
            title,
            goal,
            reason,
            created_by,
            context_snapshot_json,
            created_at,
            updated_at
          ) VALUES (?, ?, 'branch', 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          branchId,
          session.id,
          parent.id,
          sourceEvent.id,
          input.idempotencyKey,
          input.title,
          input.goal,
          input.reason,
          input.createdBy,
          encodeOptionalJson(input.contextSnapshot, "branch context snapshot"),
          createdAt,
          createdAt
        );
      const branch = this.#requireBranch(branchId);
      this.#appendLineEvent(branch, {
        type: "branch_created",
        idempotencyKey: `internal:branch-created:${branch.id}`,
        sourceEventId: sourceEvent.id,
        correlationId: branch.id,
        payload: {
          branchId: branch.id,
          title: branch.title,
          goal: branch.goal,
          reason: branch.reason,
          createdBy: branch.createdBy,
          ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot })
        },
        createdAt
      });
      return branch;
    });
  }

  async getBranch(branchId: string): Promise<ConversationBranch | undefined> {
    validateId(branchId, "branch id");
    const line = this.#getLine(branchId);
    return line?.kind === "branch" ? line : undefined;
  }

  async listBranches(sessionId: string, options: ListBranchesOptions = {}): Promise<readonly ConversationBranch[]> {
    validateId(sessionId, "session id");
    this.#requireSession(sessionId);
    if (options.statuses?.length === 0) {
      return [];
    }
    const statusClause =
      options.statuses === undefined ? "" : ` AND status IN (${placeholders(options.statuses.length)})`;
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM conversation_lines
        WHERE session_id = ?
          AND kind = 'branch'
          ${statusClause}
        ORDER BY created_at, rowid
      `)
      .all(sessionId, ...(options.statuses ?? [])) as LineRow[];
    return rows.map(requireBranchFromRow);
  }

  async transitionBranch(branchId: string, input: TransitionBranchInput): Promise<ConversationBranch> {
    validateId(branchId, "branch id");
    validateTransitionBranchInput(input);
    encodeOptionalJson(input.payload, "branch transition payload");

    return this.#write(() => {
      const internalKey = `internal:branch-status:${input.idempotencyKey}`;
      const existingEvent = this.#getEventByLineAndRequest(branchId, internalKey);
      if (existingEvent !== undefined) {
        assertTransitionEventRequest(
          existingEvent,
          "branch_status_changed",
          input.status,
          input.payload,
          input.createdAt
        );
        return branchSnapshotAtTransition(this.#requireBranch(branchId), input.status, existingEvent.createdAt);
      }

      const branch = this.#requireBranch(branchId);
      if (input.status === "merged") {
        throw new ConversationStoreError(
          "invalid_state_transition",
          `Branch "${branch.id}" can enter "merged" only through publishBranchResult().`
        );
      }
      if (!isBranchTransitionAllowed(branch.status, input.status)) {
        throw invalidTransition("branch", branch.id, branch.status, input.status);
      }
      assertWritableSession(this.#requireSession(branch.sessionId));
      const createdAt = input.createdAt ?? new Date().toISOString();
      const causationEventId = this.#lastEventId(branch.id);
      this.#appendLineEvent(branch, {
        type: "branch_status_changed",
        idempotencyKey: internalKey,
        ...(causationEventId === undefined ? {} : { causationEventId }),
        correlationId: branch.id,
        payload: {
          fromStatus: branch.status,
          toStatus: input.status,
          ...(input.payload === undefined ? {} : { detail: input.payload })
        },
        createdAt
      });
      this.#updateBranchStatus(branch.id, input.status, createdAt);
      return this.#requireBranch(branch.id);
    });
  }

  /** 按既有异步仓储契约追加会话事实 */
  async appendEvent(lineId: string, input: AppendLineEventInput): Promise<LineEvent> {
    return this.appendEventSync(lineId, input);
  }

  /** 启动恢复在接单前同步补齐回执，复用同一校验和事务边界 */
  appendEventSync(lineId: string, input: AppendLineEventInput): LineEvent {
    validateId(lineId, "line id");
    validateAppendLineEventInput(input);
    encodeOptionalJson(input.payload, "line event payload");
    return this.#write(() => this.#appendLineEvent(this.#requireLine(lineId), input));
  }

  async getEvent(eventId: string): Promise<LineEvent | undefined> {
    validateId(eventId, "line event id");
    return this.#getEvent(eventId);
  }

  async listEvents(lineId: string, options: ListLineEventsOptions = {}): Promise<readonly LineEvent[]> {
    validateId(lineId, "line id");
    validateListLineEventsOptions(options);
    this.#requireLine(lineId);
    if (options.types?.length === 0) {
      return [];
    }
    const clauses = ["line_id = ?"];
    const values: unknown[] = [lineId];
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > ?");
      values.push(options.afterSequence);
    }
    if (options.beforeSequence !== undefined) {
      clauses.push("sequence < ?");
      values.push(options.beforeSequence);
    }
    if (options.types !== undefined) {
      clauses.push(`type IN (${placeholders(options.types.length)})`);
      values.push(...options.types);
    }
    const limitSql = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) {
      values.push(options.limit);
    }
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM (
          SELECT *
          FROM line_events
          WHERE ${clauses.join(" AND ")}
          ORDER BY sequence DESC
          ${limitSql}
        )
        ORDER BY sequence
      `)
      .all(...values) as LineEventRow[];
    return rows.map(lineEventFromRow);
  }

  #assertBranchCreateRetry(existing: ConversationBranch, input: CreateBranchInput): void {
    const session = this.#requireSession(existing.sessionId);
    const parentMainlineId = input.parentMainlineId ?? session.mainlineId;
    const mismatch =
      existing.sessionId !== input.sessionId ||
      existing.parentMainlineId !== parentMainlineId ||
      existing.sourceEventId !== input.sourceEventId ||
      existing.title !== input.title ||
      existing.goal !== input.goal ||
      existing.reason !== input.reason ||
      existing.createdBy !== input.createdBy ||
      !jsonValuesEqual(existing.contextSnapshot, input.contextSnapshot) ||
      (input.id !== undefined && existing.id !== input.id) ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Branch creation request "${input.idempotencyKey}" conflicts with the stored branch.`
      );
    }
  }

  #appendLineEvent(
    line: ConversationLine,
    input: AppendLineEventInput,
    options: { readonly allowArchivedLine?: boolean } = {}
  ): LineEvent {
    const existing = this.#getEventByLineAndRequest(line.id, input.idempotencyKey);
    if (existing !== undefined) {
      this.#assertLineEventRetry(existing, line, input);
      return existing;
    }

    const session = this.#requireSession(line.sessionId);
    assertWritableSession(session);
    if (input.sessionId !== undefined && input.sessionId !== line.sessionId) {
      throw new ConversationStoreError(
        "ownership_mismatch",
        `Line "${line.id}" does not belong to session "${input.sessionId}".`
      );
    }
    if (line.status === "archived" && options.allowArchivedLine !== true) {
      throw new ConversationStoreError("invalid_state_transition", `Cannot append to archived line "${line.id}".`);
    }
    if (input.sourceNormalizedEventId !== undefined) {
      const normalized = this.#getNormalizedEvent(input.sourceNormalizedEventId);
      if (normalized === undefined) {
        const pending = this.#db
          .prepare("SELECT session_id FROM normalized_events WHERE id = ? LIMIT 1")
          .get(input.sourceNormalizedEventId) as { readonly session_id: string } | undefined;
        if (pending === undefined) {
          throw new ConversationStoreError(
            "not_found",
            `Normalized event "${input.sourceNormalizedEventId}" does not exist.`
          );
        }
        if (pending.session_id !== line.sessionId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Normalized event "${input.sourceNormalizedEventId}" does not belong to session "${line.sessionId}".`
          );
        }
      } else if (normalized.sessionId !== line.sessionId || normalized.lineId !== line.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Normalized event "${normalized.id}" must target line "${line.id}" in session "${line.sessionId}".`
        );
      }
    }
    for (const relatedEventId of [input.sourceEventId, input.causationEventId]) {
      if (relatedEventId === undefined) {
        continue;
      }
      const related = this.#requireEvent(relatedEventId);
      if (related.sessionId !== line.sessionId) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Related event "${related.id}" and target line "${line.id}" must belong to the same session.`
        );
      }
    }

    const eventId = input.id ?? `event-${randomUUID()}`;
    this.#assertUnusedLineEventId(eventId);
    const sequenceRow = this.#db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM line_events WHERE line_id = ?")
      .get(line.id) as { readonly sequence: number };
    const createdAt = input.createdAt ?? new Date().toISOString();
    const role = roleFromEventType(input.type);
    const text = textFromPayload(input.payload);
    this.#db
      .prepare(`
        INSERT INTO line_events (
          id,
          session_id,
          line_id,
          sequence,
          type,
          role,
          actor_id,
          text,
          payload_json,
          source_normalized_event_id,
          source_event_id,
          idempotency_key,
          causation_event_id,
          correlation_id,
          task_id,
          branch_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        line.sessionId,
        line.id,
        sequenceRow.sequence,
        input.type,
        role,
        input.actorId ?? null,
        text,
        encodeOptionalJson(input.payload, "line event payload"),
        input.sourceNormalizedEventId ?? null,
        input.sourceEventId ?? null,
        input.idempotencyKey,
        input.causationEventId ?? null,
        input.correlationId ?? null,
        input.taskId ?? null,
        line.kind === "branch" ? line.id : null,
        createdAt
      );
    return this.#requireEvent(eventId);
  }

  #assertLineEventRetry(existing: LineEvent, line: ConversationLine, input: AppendLineEventInput): void {
    const mismatch =
      (input.id !== undefined && existing.id !== input.id) ||
      (input.sessionId !== undefined && existing.sessionId !== input.sessionId) ||
      existing.lineId !== line.id ||
      existing.type !== input.type ||
      existing.sourceNormalizedEventId !== input.sourceNormalizedEventId ||
      existing.sourceEventId !== input.sourceEventId ||
      existing.causationEventId !== input.causationEventId ||
      existing.correlationId !== input.correlationId ||
      existing.taskId !== input.taskId ||
      existing.actorId !== input.actorId ||
      !jsonValuesEqual(existing.payload, input.payload) ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Line event request "${input.idempotencyKey}" conflicts with the stored event.`
      );
    }
  }

  #getEvent(eventId: string): LineEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM line_events WHERE id = ? LIMIT 1").get(eventId) as
      | LineEventRow
      | undefined;
    return row === undefined ? undefined : lineEventFromRow(row);
  }

  #requireEvent(eventId: string): LineEvent {
    const event = this.#getEvent(eventId);
    if (event === undefined) {
      throw new ConversationStoreError("not_found", `Line event "${eventId}" does not exist.`);
    }
    return event;
  }

  #getEventByLineAndRequest(lineId: string, idempotencyKey: string): LineEvent | undefined {
    const row = this.#db
      .prepare("SELECT * FROM line_events WHERE line_id = ? AND idempotency_key = ? LIMIT 1")
      .get(lineId, idempotencyKey) as LineEventRow | undefined;
    return row === undefined ? undefined : lineEventFromRow(row);
  }

  #lastEventId(lineId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT id FROM line_events WHERE line_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(lineId) as { readonly id: string } | undefined;
    return row?.id;
  }

  #requireMainlineById(lineId: string): ConversationMainline {
    const line = this.#requireLine(lineId);
    if (line.kind !== "mainline") {
      throw new ConversationStoreError("validation_error", `Conversation line "${lineId}" is not a mainline.`);
    }
    return line;
  }

  #requireBranch(branchId: string): ConversationBranch {
    const line = this.#requireLine(branchId);
    if (line.kind !== "branch") {
      throw new ConversationStoreError("validation_error", `Conversation line "${branchId}" is not a branch.`);
    }
    return line;
  }

  #updateBranchStatus(branchId: string, status: ConversationBranch["status"], at: string): void {
    this.#db
      .prepare(`
        UPDATE conversation_lines
        SET status = ?,
            updated_at = ?,
            completed_at = CASE
              WHEN ? = 'completed' THEN COALESCE(completed_at, ?)
              ELSE completed_at
            END,
            merged_at = CASE
              WHEN ? = 'merged' THEN COALESCE(merged_at, ?)
              ELSE merged_at
            END,
            archived_at = CASE
              WHEN ? = 'archived' THEN COALESCE(archived_at, ?)
              ELSE archived_at
            END
        WHERE id = ?
      `)
      .run(status, at, status, at, status, at, status, at, branchId);
  }

  async createBranchResult(branchId: string, input: CreateBranchResultInput): Promise<BranchResult> {
    validateId(branchId, "branch id");
    validateCreateBranchResultInput(input);
    encodeRequiredJson(input.artifacts ?? [], "branch result artifacts");
    encodeRequiredJson(input.citations ?? [], "branch result citations");

    const result = this.#write(() => {
      const existingRow = this.#db
        .prepare(`
          SELECT *
          FROM branch_results
          WHERE branch_line_id = ? AND create_request_id = ?
          LIMIT 1
        `)
        .get(branchId, input.idempotencyKey) as ResultRow | undefined;
      if (existingRow !== undefined) {
        const existing = this.#resultFromRow(existingRow);
        this.#assertResultCreateRetry(existing, input);
        return existing;
      }

      const branch = this.#requireBranch(branchId);
      assertBranchCanCreateResult(branch, input.status);
      assertWritableSession(this.#requireSession(branch.sessionId));
      if (input.sourceEventId !== undefined) {
        const sourceEvent = this.#requireEvent(input.sourceEventId);
        if (sourceEvent.sessionId !== branch.sessionId || sourceEvent.lineId !== branch.id) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Result source event "${sourceEvent.id}" must belong to branch "${branch.id}".`
          );
        }
      }

      const versionRow = this.#db
        .prepare("SELECT COUNT(*) + 1 AS version FROM branch_results WHERE branch_line_id = ?")
        .get(branch.id) as { readonly version: number };
      const version = input.version ?? versionRow.version;
      if (version !== versionRow.version) {
        throw new ConversationStoreError(
          "conflict",
          `Branch "${branch.id}" expects result version ${versionRow.version}, but version ${version} was requested.`
        );
      }
      const resultId = input.id ?? `branch-result-${randomUUID()}`;
      if (this.#db.prepare("SELECT 1 FROM branch_results WHERE id = ?").get(resultId) !== undefined) {
        throw new ConversationStoreError("conflict", `Branch result "${resultId}" already exists.`);
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.#db
        .prepare(`
          INSERT INTO branch_results (
            id,
            session_id,
            branch_line_id,
            version,
            status,
            summary,
            artifacts_json,
            citations_json,
            next_actions_json,
            create_request_id,
            source_event_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          resultId,
          branch.sessionId,
          branch.id,
          version,
          input.status,
          input.summary,
          encodeRequiredJson(input.artifacts ?? [], "branch result artifacts"),
          encodeRequiredJson(input.citations ?? [], "branch result citations"),
          encodeRequiredJson(input.nextActions ?? [], "branch result next actions"),
          input.idempotencyKey,
          input.sourceEventId ?? null,
          createdAt
        );
      const createdResult = this.#requireBranchResult(resultId);
      const causationEventId = input.sourceEventId ?? this.#lastEventId(branch.id);
      this.#appendLineEvent(branch, {
        type: "branch_result",
        idempotencyKey: `internal:branch-result:${createdResult.id}`,
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
        ...(causationEventId === undefined ? {} : { causationEventId }),
        correlationId: branch.id,
        payload: branchResultPayload(branch, createdResult),
        createdAt
      });
      return createdResult;
    });
    const resultEvent = this.#getEventByLineAndRequest(branchId, `internal:branch-result:${result.id}`);
    if (resultEvent === undefined) {
      throw new ConversationStoreError("not_found", `Branch result event for "${result.id}" does not exist.`);
    }
    return result;
  }

  async getBranchResult(resultId: string): Promise<BranchResult | undefined> {
    validateId(resultId, "branch result id");
    const row = this.#db.prepare("SELECT * FROM branch_results WHERE id = ? LIMIT 1").get(resultId) as
      | ResultRow
      | undefined;
    return row === undefined ? undefined : this.#resultFromRow(row);
  }

  async listBranchResults(branchId: string): Promise<readonly BranchResult[]> {
    validateId(branchId, "branch id");
    this.#requireBranch(branchId);
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM branch_results
        WHERE branch_line_id = ?
        ORDER BY version, rowid
      `)
      .all(branchId) as ResultRow[];
    return rows.map((row) => this.#resultFromRow(row));
  }

  /**
   * 将阶段结果发布到主线并保留原分支生命周期
   */
  async publishBranchResult(
    branchId: string,
    mainlineId: string,
    input: PublishBranchResultInput = {}
  ): Promise<BranchPublication> {
    validateId(branchId, "branch id");
    validateId(mainlineId, "mainline id");
    validateMergeInput(input);

    return this.#write(() => {
      const branch = this.#requireBranch(branchId);
      const mainline = this.#requireMainlineById(mainlineId);
      if (mainline.sessionId !== branch.sessionId || branch.parentMainlineId !== mainline.id) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Branch "${branch.id}" and mainline "${mainline.id}" must belong to the same parent relationship.`
        );
      }
      const result =
        input.resultId === undefined ? this.#latestResult(branch.id) : this.#requireBranchResult(input.resultId);
      if (result.branchId !== branch.id || result.sessionId !== branch.sessionId) {
        throw new ConversationStoreError(
          "ownership_mismatch",
          `Result "${result.id}" does not belong to branch "${branch.id}".`
        );
      }
      const idempotencyKey = input.idempotencyKey ?? `result:${result.id}`;
      const existingByRequest = this.#db
        .prepare(`
          SELECT branch_merges.*, conversation_lines.session_id
          FROM branch_merges
          JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
          WHERE branch_merges.branch_line_id = ?
            AND branch_merges.create_request_id = ?
          LIMIT 1
        `)
        .get(branch.id, idempotencyKey) as MergeRow | undefined;
      if (existingByRequest !== undefined) {
        const existing = mergeFromRow(existingByRequest);
        this.#assertMergeRetry(existing, mainline.id, result.id, input);
        return existing;
      }

      const naturalMerge = this.#db
        .prepare(`
          SELECT branch_merges.*, conversation_lines.session_id
          FROM branch_merges
          JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
          WHERE branch_merges.result_id = ?
          ORDER BY branch_merges.rowid
          LIMIT 1
        `)
        .get(result.id) as MergeRow | undefined;
      if (naturalMerge !== undefined) {
        return mergeFromRow(naturalMerge);
      }
      assertWritableSession(this.#requireSession(branch.sessionId));

      const createdAt = input.createdAt ?? new Date().toISOString();
      const resultEvent = this.#getEventByLineAndRequest(branch.id, `internal:branch-result:${result.id}`);
      if (resultEvent === undefined) {
        throw new ConversationStoreError("not_found", `Branch result event for "${result.id}" does not exist.`);
      }
      const mainlineEvent = this.#appendLineEvent(mainline, {
        ...(input.eventId === undefined ? {} : { id: input.eventId }),
        type: "branch_result",
        idempotencyKey: `internal:merge-result:${result.id}:mainline`,
        sourceEventId: resultEvent.id,
        causationEventId: resultEvent.id,
        correlationId: branch.id,
        payload: branchResultPayload(branch, result),
        createdAt
      });
      const branchEvent = this.#appendLineEvent(
        branch,
        {
          ...(input.branchEventId === undefined ? {} : { id: input.branchEventId }),
          type: "branch_result_published",
          idempotencyKey: `internal:merge-result:${result.id}:branch`,
          sourceEventId: resultEvent.id,
          causationEventId: mainlineEvent.id,
          correlationId: branch.id,
          payload: {
            resultId: result.id,
            version: result.version,
            mainlineId: mainline.id,
            mainlineEventId: mainlineEvent.id
          },
          createdAt
        },
        { allowArchivedLine: branch.status === "archived" }
      );
      const mergeId = input.id ?? `branch-merge-${randomUUID()}`;
      const existingMergeId = this.#db.prepare("SELECT 1 FROM branch_merges WHERE id = ?").get(mergeId);
      if (existingMergeId !== undefined) {
        throw new ConversationStoreError("conflict", `Branch merge "${mergeId}" already exists.`);
      }
      this.#db
        .prepare(`
          INSERT INTO branch_merges (
            id,
            result_id,
            branch_line_id,
            mainline_id,
            mainline_event_id,
            branch_event_id,
            create_request_id,
            merged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(mergeId, result.id, branch.id, mainline.id, mainlineEvent.id, branchEvent.id, idempotencyKey, createdAt);
      this.#db
        .prepare(`
          UPDATE conversation_lines
          SET updated_at = ?,
              merged_at = COALESCE(merged_at, ?)
          WHERE id = ?
        `)
        .run(createdAt, createdAt, branch.id);
      return this.#requireMerge(mergeId);
    });
  }

  #resultFromRow(row: ResultRow): BranchResult {
    return {
      id: row.id,
      sessionId: row.session_id,
      branchId: row.branch_line_id,
      version: row.version,
      status: row.status,
      summary: row.summary,
      artifacts: decodeJson<readonly unknown[]>(row.artifacts_json, "branch result artifacts"),
      citations: decodeJson<readonly unknown[]>(row.citations_json, "branch result citations"),
      nextActions: decodeJson<readonly string[]>(row.next_actions_json, "branch result next actions"),
      idempotencyKey: row.create_request_id,
      ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
      createdAt: row.created_at
    };
  }

  #requireBranchResult(resultId: string): BranchResult {
    const row = this.#db.prepare("SELECT * FROM branch_results WHERE id = ? LIMIT 1").get(resultId) as
      | ResultRow
      | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Branch result "${resultId}" does not exist.`);
    }
    return this.#resultFromRow(row);
  }

  #latestResult(branchId: string): BranchResult {
    const row = this.#db
      .prepare(`
        SELECT *
        FROM branch_results
        WHERE branch_line_id = ?
        ORDER BY version DESC
        LIMIT 1
      `)
      .get(branchId) as ResultRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Branch "${branchId}" has no result to merge.`);
    }
    return this.#resultFromRow(row);
  }

  #assertSessionCanArchive(sessionId: string): void {
    const openBranch = this.#db
      .prepare(`
        SELECT id
        FROM conversation_lines
        WHERE session_id = ?
          AND kind = 'branch'
          AND status NOT IN (${placeholders(SESSION_ARCHIVABLE_BRANCH_STATUSES.size)})
        LIMIT 1
      `)
      .get(sessionId, ...SESSION_ARCHIVABLE_BRANCH_STATUSES);
    if (openBranch !== undefined) {
      throw new ConversationStoreError(
        "invalid_state_transition",
        `Session "${sessionId}" cannot be archived while branches or tasks are unfinished.`
      );
    }
  }

  #assertResultCreateRetry(existing: BranchResult, input: CreateBranchResultInput): void {
    const mismatch =
      (input.id !== undefined && existing.id !== input.id) ||
      (input.version !== undefined && existing.version !== input.version) ||
      existing.status !== input.status ||
      existing.summary !== input.summary ||
      !jsonValuesEqual(existing.artifacts, input.artifacts ?? []) ||
      !jsonValuesEqual(existing.citations, input.citations ?? []) ||
      !jsonValuesEqual(existing.nextActions, input.nextActions ?? []) ||
      existing.sourceEventId !== input.sourceEventId ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Branch result request "${input.idempotencyKey}" conflicts with the stored result.`
      );
    }
  }

  #requireMerge(mergeId: string): BranchPublication {
    const row = this.#db
      .prepare(`
        SELECT branch_merges.*, conversation_lines.session_id
        FROM branch_merges
        JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
        WHERE branch_merges.id = ?
        LIMIT 1
      `)
      .get(mergeId) as MergeRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Branch merge "${mergeId}" does not exist.`);
    }
    return mergeFromRow(row);
  }

  #assertMergeRetry(
    existing: BranchPublication,
    mainlineId: string,
    resultId: string,
    input: PublishBranchResultInput
  ): void {
    const mismatch =
      existing.mainlineId !== mainlineId ||
      existing.resultId !== resultId ||
      (input.id !== undefined && existing.id !== input.id) ||
      (input.eventId !== undefined && existing.mainlineEventId !== input.eventId) ||
      (input.branchEventId !== undefined && existing.branchEventId !== input.branchEventId) ||
      (input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Branch merge request "${existing.idempotencyKey}" conflicts with the stored merge.`
      );
    }
  }

  async getBranchContext(branchId: string): Promise<BranchContext> {
    validateId(branchId, "branch id");
    return this.#read(() => {
      const branch = this.#requireBranch(branchId);
      const session = this.#requireSession(branch.sessionId);
      const mainline = this.#requireMainline(session.id);
      const sourceEvent = this.#requireEvent(branch.sourceEventId);
      const events = this.#listAllEvents(branch.id);
      const resultRows = this.#db
        .prepare(`
          SELECT *
          FROM branch_results
          WHERE branch_line_id = ?
          ORDER BY version, rowid
        `)
        .all(branch.id) as ResultRow[];
      return {
        session,
        mainline,
        branch,
        sourceEvent,
        ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot }),
        events,
        results: resultRows.map((row) => this.#resultFromRow(row))
      };
    });
  }

  async getRecoveryState(sessionId?: string): Promise<ConversationRecoveryState> {
    if (sessionId !== undefined) {
      validateId(sessionId, "session id");
    }
    return this.#read(() => {
      if (sessionId !== undefined) {
        this.#requireSession(sessionId);
      }
      const filter = sessionId === undefined ? "" : " AND id = ?";
      const sessionRows = this.#db
        .prepare(`
          SELECT *
          FROM conversation_sessions
          WHERE status = 'active'
          ${filter}
          ORDER BY created_at, rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as SessionRow[];
      const sessions = sessionRows.map(sessionFromRow);
      const mainlines = sessions.map((session) => this.#requireMainline(session.id));

      const branchRows = this.#db
        .prepare(`
          SELECT conversation_lines.*
          FROM conversation_lines
          JOIN conversation_sessions
            ON conversation_sessions.id = conversation_lines.session_id
          WHERE conversation_lines.kind = 'branch'
            AND conversation_lines.status IN ('created', 'active', 'blocked', 'inactive', 'completed')
            AND conversation_sessions.status = 'active'
            ${sessionId === undefined ? "" : " AND conversation_lines.session_id = ?"}
          ORDER BY conversation_lines.created_at, conversation_lines.rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as LineRow[];
      const resultRows = this.#db
        .prepare(`
          SELECT branch_results.*
          FROM branch_results
          JOIN conversation_sessions
            ON conversation_sessions.id = branch_results.session_id
          JOIN conversation_lines
            ON conversation_lines.id = branch_results.branch_line_id
          LEFT JOIN branch_merges ON branch_merges.result_id = branch_results.id
          WHERE branch_merges.id IS NULL
            AND branch_results.status = 'completed'
            AND conversation_lines.status NOT IN ('failed', 'cancelled')
            AND conversation_sessions.status = 'active'
            ${sessionId === undefined ? "" : " AND branch_results.session_id = ?"}
          ORDER BY branch_results.created_at, branch_results.rowid
        `)
        .all(...(sessionId === undefined ? [] : [sessionId])) as ResultRow[];
      return {
        sessions,
        mainlines,
        activeBranches: branchRows.map(requireBranchFromRow),
        unmergedResults: resultRows.map((row) => this.#resultFromRow(row))
      };
    });
  }

  async getEventTrace(eventId: string): Promise<EventTrace> {
    validateId(eventId, "line event id");
    return this.#read(() => {
      const event = this.#requireEvent(eventId);
      const line = this.#requireLine(event.lineId);
      const session = this.#requireSession(event.sessionId);
      const branch = line.kind === "branch" ? line : undefined;
      const sourceEvent = event.sourceEventId === undefined ? undefined : this.#getEvent(event.sourceEventId);
      const causationChain = this.#causationChain(event);
      const sessionEvents = (
        this.#db
          .prepare(`
          SELECT *
          FROM line_events
          WHERE session_id = ?
          ORDER BY ordinal
        `)
          .all(event.sessionId) as LineEventRow[]
      ).map(lineEventFromRow);
      return {
        event,
        line,
        session,
        ...(branch === undefined ? {} : { branch }),
        ...(sourceEvent === undefined ? {} : { sourceEvent }),
        causationChain,
        relatedEvents: collectRelatedEvents(sessionEvents, event, causationChain)
      };
    });
  }

  async getBranchResultTrace(resultId: string): Promise<BranchResultTrace> {
    validateId(resultId, "branch result id");
    return this.#read(() => {
      const result = this.#requireBranchResult(resultId);
      const branch = this.#requireBranch(result.branchId);
      const session = this.#requireSession(result.sessionId);
      const mainline = this.#requireMainline(session.id);
      const sourceEvent = result.sourceEventId === undefined ? undefined : this.#requireEvent(result.sourceEventId);
      const mergeRow = this.#db
        .prepare(`
          SELECT branch_merges.*, conversation_lines.session_id
          FROM branch_merges
          JOIN conversation_lines ON conversation_lines.id = branch_merges.branch_line_id
          WHERE branch_merges.result_id = ?
          ORDER BY branch_merges.rowid
          LIMIT 1
        `)
        .get(result.id) as MergeRow | undefined;
      const merge = mergeRow === undefined ? undefined : mergeFromRow(mergeRow);
      const mainlineEvent = merge === undefined ? undefined : this.#requireEvent(merge.mainlineEventId);
      return {
        result,
        branch,
        mainline,
        session,
        ...(sourceEvent === undefined ? {} : { sourceEvent }),
        ...(merge === undefined ? {} : { publication: merge }),
        ...(mainlineEvent === undefined ? {} : { mainlineEvent })
      };
    });
  }

  #listAllEvents(lineId: string): readonly LineEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM line_events WHERE line_id = ? ORDER BY sequence")
      .all(lineId) as LineEventRow[];
    return rows.map(lineEventFromRow);
  }

  #causationChain(event: LineEvent): readonly LineEvent[] {
    const result: LineEvent[] = [];
    const visited = new Set<string>([event.id]);
    let cursor = event.causationEventId ?? event.sourceEventId;
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      const ancestor = this.#getEvent(cursor);
      if (ancestor === undefined) {
        break;
      }
      result.unshift(ancestor);
      cursor = ancestor.causationEventId ?? ancestor.sourceEventId;
    }
    result.push(event);
    return result;
  }

  #read<T>(operation: () => T): T {
    return this.#db.transaction(operation).deferred();
  }

  #createOrEnsureSession(input: CreateSessionInput, ensure: boolean): ConversationSession {
    const requestedId = resolveSessionId(input);
    if (input.idempotencyKey !== undefined) {
      const idempotentRow = this.#db
        .prepare("SELECT * FROM conversation_sessions WHERE idempotency_key = ? ORDER BY rowid LIMIT 1")
        .get(input.idempotencyKey) as SessionRow | undefined;
      if (idempotentRow !== undefined) {
        const existing = sessionFromRow(idempotentRow);
        this.#assertSessionMatchesInput(existing, input, true);
        return existing;
      }
    }

    if (requestedId !== undefined) {
      const existing = this.#getSession(requestedId);
      if (existing !== undefined) {
        if (!ensure) {
          throw new ConversationStoreError("conflict", `Session "${requestedId}" already exists.`);
        }
        this.#assertSessionMatchesInput(existing, input, false);
        return existing;
      }
    }

    if (input.locator !== undefined) {
      const located = this.#findSessionByLocator(input.locator);
      if (located !== undefined) {
        if (!ensure) {
          throw new ConversationStoreError(
            "conflict",
            `A session already exists for conversation "${input.locator.conversationId}".`
          );
        }
        if (requestedId !== undefined && located.id !== requestedId) {
          throw new ConversationStoreError(
            "ownership_mismatch",
            `Conversation "${input.locator.conversationId}" belongs to session "${located.id}", not "${requestedId}".`
          );
        }
        this.#assertSessionMatchesInput(located, input, false);
        return located;
      }
    }

    const id = requestedId ?? `session:${randomUUID()}`;
    const mainlineId = input.mainlineId ?? `mainline:${id}`;
    if (this.#getLine(mainlineId) !== undefined) {
      throw new ConversationStoreError("conflict", `Line "${mainlineId}" already exists.`);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const locator = input.locator;
    this.#db
      .prepare(`
        INSERT INTO conversation_sessions (
          id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          status,
          mainline_id,
          workspace_id,
          metadata_json,
          idempotency_key,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        locator?.platform ?? null,
        locator?.provider ?? null,
        locator?.channelId ?? null,
        locator?.conversationType ?? null,
        locator?.conversationId ?? null,
        mainlineId,
        input.workspaceId ?? null,
        encodeOptionalJson(input.metadata, "session metadata"),
        input.idempotencyKey ?? null,
        createdAt,
        createdAt
      );
    this.#db
      .prepare(`
        INSERT INTO conversation_lines (
          id,
          session_id,
          kind,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, 'mainline', 'active', ?, ?)
      `)
      .run(mainlineId, id, createdAt, createdAt);
    return this.#requireSession(id);
  }

  #assertSessionMatchesInput(existing: ConversationSession, input: CreateSessionInput, exact: boolean): void {
    const requestedId = resolveSessionId(input);
    const mismatch =
      (requestedId !== undefined && existing.id !== requestedId) ||
      (input.mainlineId !== undefined && existing.mainlineId !== input.mainlineId) ||
      (input.locator !== undefined &&
        (exact || existing.locator !== undefined) &&
        !locatorsEqual(existing.locator, input.locator)) ||
      (exact && input.locator === undefined && existing.locator !== undefined) ||
      (input.workspaceId !== undefined && existing.workspaceId !== input.workspaceId) ||
      (exact && input.workspaceId === undefined && existing.workspaceId !== undefined) ||
      (exact && input.metadata !== undefined && !jsonValuesEqual(existing.metadata, input.metadata)) ||
      (exact && input.metadata === undefined && existing.metadata !== undefined) ||
      (exact && input.createdAt !== undefined && existing.createdAt !== input.createdAt);
    if (mismatch) {
      throw new ConversationStoreError(
        input.idempotencyKey === undefined ? "conflict" : "idempotency_conflict",
        `Session request "${input.idempotencyKey ?? existing.id}" conflicts with the stored session.`
      );
    }
  }

  #findSessionByLocator(locator: ConversationSessionLocator): ConversationSession | undefined {
    const row = this.#db
      .prepare(`
        SELECT *
        FROM conversation_sessions
        WHERE platform = ?
          AND provider = ?
          AND channel_id = ?
          AND conversation_type = ?
          AND conversation_id = ?
        LIMIT 1
      `)
      .get(locator.platform, locator.provider, locator.channelId, locator.conversationType, locator.conversationId) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  #getSession(sessionId: string): ConversationSession | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_sessions WHERE id = ? LIMIT 1").get(sessionId) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  #requireSession(sessionId: string): ConversationSession {
    const session = this.#getSession(sessionId);
    if (session === undefined) {
      throw new ConversationStoreError("not_found", `Session "${sessionId}" does not exist.`);
    }
    return session;
  }

  #getLine(lineId: string): ConversationLine | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_lines WHERE id = ? LIMIT 1").get(lineId) as
      | LineRow
      | undefined;
    return row === undefined ? undefined : lineFromRow(row);
  }

  #requireLine(lineId: string): ConversationLine {
    const line = this.#getLine(lineId);
    if (line === undefined) {
      throw new ConversationStoreError("not_found", `Line "${lineId}" does not exist.`);
    }
    return line;
  }

  #requireMainline(sessionId: string): ConversationMainline {
    const row = this.#db
      .prepare("SELECT * FROM conversation_lines WHERE session_id = ? AND kind = 'mainline' LIMIT 1")
      .get(sessionId) as LineRow | undefined;
    if (row === undefined) {
      throw new ConversationStoreError("not_found", `Session "${sessionId}" has no mainline.`);
    }
    const line = lineFromRow(row);
    if (line.kind !== "mainline") {
      throw new ConversationStoreError("conflict", `Session "${sessionId}" has an invalid mainline.`);
    }
    return line;
  }

  #getNormalizedEvent(eventId: string): NormalizedEvent | undefined {
    const row = this.#db
      .prepare(`
        SELECT
          normalized_events.*,
          line_events.line_id,
          line_events.id AS line_event_id
        FROM normalized_events
        JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.id = ?
        LIMIT 1
      `)
      .get(eventId) as NormalizedEventRow | undefined;
    return row === undefined ? undefined : normalizedEventFromRow(row);
  }

  #requireNormalizedEvent(eventId: string): NormalizedEvent {
    const event = this.#getNormalizedEvent(eventId);
    if (event === undefined) {
      throw new ConversationStoreError("not_found", `Normalized event "${eventId}" does not exist.`);
    }
    return event;
  }

  #getNormalizedEventByIdempotencyKey(idempotencyKey: string): NormalizedEvent | undefined {
    const row = this.#db
      .prepare(`
        SELECT
          normalized_events.*,
          line_events.line_id,
          line_events.id AS line_event_id
        FROM normalized_events
        JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.idempotency_key = ?
        LIMIT 1
      `)
      .get(idempotencyKey) as NormalizedEventRow | undefined;
    return row === undefined ? undefined : normalizedEventFromRow(row);
  }

  #assertNormalizedEventRetry(
    existing: NormalizedEvent,
    input: AcceptNormalizedEventInput,
    segments: readonly unknown[]
  ): void {
    const lineEvent = this.#requireEvent(existing.lineEventId);
    const expectedLineEventType = input.lineEventType ?? "user_message";
    const expectedPayload = {
      normalizedEventId: existing.id,
      text: input.text,
      ...(input.message === undefined ? {} : { message: input.message }),
      segments,
      ...(input.triggerHint === undefined ? {} : { triggerHint: input.triggerHint })
    };
    const mismatch =
      (input.id !== undefined && existing.id !== input.id) ||
      (input.lineEventId !== undefined && existing.lineEventId !== input.lineEventId) ||
      (input.targetLineId !== undefined && existing.lineId !== input.targetLineId) ||
      existing.sessionId !== input.sessionId ||
      existing.platform !== input.platform ||
      existing.provider !== input.provider ||
      existing.channelId !== input.channelId ||
      existing.conversationType !== input.conversationType ||
      existing.conversationId !== input.conversationId ||
      existing.sourceEventId !== input.sourceEventId ||
      existing.sourceMessageId !== input.sourceMessageId ||
      existing.sourceEventType !== input.sourceEventType ||
      existing.senderId !== input.senderId ||
      existing.text !== input.text ||
      !jsonValuesEqual(existing.message, input.message) ||
      !jsonValuesEqual(existing.segments, segments) ||
      !jsonValuesEqual(existing.triggerHint, input.triggerHint) ||
      !jsonValuesEqual(existing.rawPayload, input.rawPayload) ||
      existing.receivedAt !== input.receivedAt ||
      lineEvent.type !== expectedLineEventType ||
      lineEvent.idempotencyKey !== `normalized:${input.idempotencyKey}` ||
      lineEvent.actorId !== input.actorId ||
      !jsonValuesEqual(lineEvent.payload, expectedPayload);
    if (mismatch) {
      throw new ConversationStoreError(
        "idempotency_conflict",
        `Normalized event request "${input.idempotencyKey}" conflicts with the stored event.`
      );
    }
  }

  #assertUnusedNormalizedEventId(eventId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM normalized_events WHERE id = ?").get(eventId);
    if (row !== undefined) {
      throw new ConversationStoreError("conflict", `Normalized event "${eventId}" already exists.`);
    }
  }

  #assertUnusedLineEventId(eventId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM line_events WHERE id = ?").get(eventId);
    if (row !== undefined) {
      throw new ConversationStoreError("conflict", `Line event "${eventId}" already exists.`);
    }
  }

  #write<T>(operation: () => T): T {
    try {
      return this.#db.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof ConversationStoreError) {
        throw error;
      }
      if (isSqliteConstraintError(error)) {
        throw new ConversationStoreError("conflict", `Conversation persistence conflict: ${error.message}`);
      }
      throw error;
    }
  }
}

function sessionFromRow(row: SessionRow): ConversationSession {
  const locator =
    row.platform === null ||
    row.provider === null ||
    row.channel_id === null ||
    row.conversation_type === null ||
    row.conversation_id === null
      ? undefined
      : {
          platform: row.platform,
          provider: row.provider,
          channelId: row.channel_id,
          conversationType: row.conversation_type,
          conversationId: row.conversation_id
        };
  return {
    id: row.id,
    mainlineId: row.mainline_id,
    status: row.status,
    ...(locator === undefined ? {} : { locator }),
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    ...(row.metadata_json === null ? {} : { metadata: decodeJson(row.metadata_json, "session metadata") }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function lineFromRow(row: LineRow): ConversationLine {
  if (row.kind === "mainline") {
    if (row.status !== "active" && row.status !== "archived") {
      throw new ConversationStoreError("conflict", `Mainline "${row.id}" has invalid status "${row.status}".`);
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: "mainline",
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  if (
    row.parent_mainline_id === null ||
    row.source_line_event_id === null ||
    row.title === null ||
    row.goal === null ||
    row.reason === null ||
    row.created_by === null ||
    row.create_request_id === null
  ) {
    throw new ConversationStoreError("conflict", `Branch "${row.id}" is missing required persisted fields.`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: "branch",
    parentMainlineId: row.parent_mainline_id,
    sourceEventId: row.source_line_event_id,
    title: row.title,
    goal: row.goal,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    idempotencyKey: row.create_request_id,
    ...(row.context_snapshot_json === null
      ? {}
      : { contextSnapshot: decodeJson(row.context_snapshot_json, "branch context snapshot") }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.merged_at === null ? {} : { mergedAt: row.merged_at }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at })
  };
}

function normalizedEventFromRow(row: NormalizedEventRow): NormalizedEvent {
  const segments =
    row.segments_json === null
      ? []
      : decodeJson<NormalizedEvent["segments"]>(row.segments_json, "normalized event segments");
  return {
    id: row.id,
    sessionId: row.session_id,
    lineId: row.line_id,
    lineEventId: row.line_event_id,
    platform: row.platform,
    provider: row.provider,
    channelId: row.channel_id,
    conversationType: row.conversation_type,
    conversationId: row.conversation_id,
    sourceEventId: row.source_event_id,
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    sourceEventType: row.source_event_type,
    senderId: row.sender_id,
    text: row.text,
    ...(row.message_json === null
      ? {}
      : { message: decodeJson<NonNullable<NormalizedEvent["message"]>>(row.message_json, "normalized event message") }),
    segments,
    ...(row.trigger_hint_json === null
      ? {}
      : {
          triggerHint: decodeJson<NonNullable<NormalizedEvent["triggerHint"]>>(
            row.trigger_hint_json,
            "normalized event trigger hint"
          )
        }),
    ...(row.raw_payload_json === null
      ? {}
      : { rawPayload: decodeJson(row.raw_payload_json, "normalized event raw payload") }),
    receivedAt: row.received_at,
    idempotencyKey: row.idempotency_key,
    acceptedAt: row.ingested_at
  };
}

function lineEventFromRow(row: LineEventRow): LineEvent {
  return {
    id: row.id,
    ordinal: row.ordinal,
    sequence: row.sequence,
    sessionId: row.session_id,
    lineId: row.line_id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    ...(row.source_normalized_event_id === null ? {} : { sourceNormalizedEventId: row.source_normalized_event_id }),
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.causation_event_id === null ? {} : { causationEventId: row.causation_event_id }),
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    ...(row.payload_json === null ? {} : { payload: decodeJson(row.payload_json, "line event payload") }),
    createdAt: row.created_at
  };
}

function mergeFromRow(row: MergeRow): BranchPublication {
  return {
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_line_id,
    resultId: row.result_id,
    mainlineId: row.mainline_id,
    mainlineEventId: row.mainline_event_id,
    branchEventId: row.branch_event_id,
    idempotencyKey: row.create_request_id,
    createdAt: row.merged_at
  };
}

function requireBranchFromRow(row: LineRow): ConversationBranch {
  const line = lineFromRow(row);
  if (line.kind !== "branch") {
    throw new ConversationStoreError("conflict", `Line "${line.id}" is not a branch.`);
  }
  return line;
}

function branchCreationSnapshot(branch: ConversationBranch): ConversationBranch {
  return {
    id: branch.id,
    sessionId: branch.sessionId,
    kind: "branch",
    parentMainlineId: branch.parentMainlineId,
    sourceEventId: branch.sourceEventId,
    title: branch.title,
    goal: branch.goal,
    reason: branch.reason,
    status: "created",
    createdBy: branch.createdBy,
    idempotencyKey: branch.idempotencyKey,
    ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: branch.contextSnapshot }),
    createdAt: branch.createdAt,
    updatedAt: branch.createdAt
  };
}

function branchSnapshotAtTransition(
  branch: ConversationBranch,
  status: ConversationBranch["status"],
  at: string
): ConversationBranch {
  const initial = branchCreationSnapshot(branch);
  return {
    ...initial,
    status,
    updatedAt: at,
    ...(status === "completed" ? { completedAt: at } : {}),
    ...(status === "merged" ? { mergedAt: at } : {}),
    ...(status === "archived" ? { archivedAt: at } : {})
  };
}

function branchResultPayload(branch: ConversationBranch, result: BranchResult): unknown {
  return {
    resultId: result.id,
    branchId: branch.id,
    version: result.version,
    status: result.status,
    goal: branch.goal,
    summary: result.summary,
    artifacts: result.artifacts,
    citations: result.citations,
    nextActions: result.nextActions
  };
}

function eventPayloadRecord(event: LineEvent | undefined, operation: string): Record<string, unknown> | undefined {
  if (event === undefined) {
    return undefined;
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new ConversationStoreError("conflict", `Stored ${operation} event has an invalid payload.`);
  }
  return event.payload as Record<string, unknown>;
}

function assertTransitionEventRequest(
  event: LineEvent,
  type: LineEventType,
  targetStatus: string,
  detail: unknown,
  createdAt: string | undefined
): void {
  const payload = eventPayloadRecord(event, "transition");
  const storedDetail = payload !== undefined && Object.hasOwn(payload, "detail") ? payload.detail : undefined;
  if (
    event.type !== type ||
    payload?.toStatus !== targetStatus ||
    !jsonValuesEqual(storedDetail, detail) ||
    (createdAt !== undefined && event.createdAt !== createdAt)
  ) {
    throw new ConversationStoreError(
      "idempotency_conflict",
      `Transition request "${event.idempotencyKey}" conflicts with the stored event.`
    );
  }
}

function roleFromEventType(type: LineEventType): "user" | "assistant" | "system" | null {
  if (type === "user_message") {
    return "user";
  }
  if (type === "assistant_message") {
    return "assistant";
  }
  if (type === "system_message") {
    return "system";
  }
  return null;
}

function textFromPayload(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "text" in payload &&
    typeof (payload as { readonly text?: unknown }).text === "string"
  ) {
    return (payload as { readonly text: string }).text;
  }
  return null;
}

function validateCreateSessionInput(input: CreateSessionInput): void {
  if (input.id !== undefined) {
    validateId(input.id, "session id");
  }
  if (input.sessionId !== undefined) {
    validateId(input.sessionId, "session id");
  }
  if (input.id !== undefined && input.sessionId !== undefined && input.id !== input.sessionId) {
    throw new ConversationStoreError("validation_error", "Session id aliases must have the same value.");
  }
  if (input.id === undefined && input.sessionId === undefined) {
    throw new ConversationStoreError("validation_error", "createSession requires a non-empty id or sessionId.");
  }
  if (input.mainlineId !== undefined) {
    validateId(input.mainlineId, "mainline id");
  }
  if (input.idempotencyKey !== undefined) {
    validateId(input.idempotencyKey, "idempotency key");
  }
  if (input.workspaceId !== undefined) {
    validateId(input.workspaceId, "workspace id");
  }
  validateTimestamp(input.createdAt, "createdAt");
  if (input.locator !== undefined) {
    validateLocator(input.locator);
  }
}

function validateNormalizedEventInput(input: AcceptNormalizedEventInput): void {
  validateId(input.sessionId, "session id");
  validateId(input.idempotencyKey, "idempotency key");
  validateId(input.platform, "platform");
  validateId(input.provider, "provider");
  validateId(input.channelId, "channel id");
  validateId(input.conversationId, "conversation id");
  validateId(input.sourceEventId, "source event id");
  validateId(input.sourceEventType, "source event type");
  validateId(input.senderId, "sender id");
  validateTimestamp(input.receivedAt, "receivedAt", true);
  if (!LOCATOR_TYPES.has(input.conversationType)) {
    throw new ConversationStoreError("validation_error", `Unsupported conversation type "${input.conversationType}".`);
  }
  for (const [value, label] of [
    [input.id, "normalized event id"],
    [input.lineEventId, "line event id"],
    [input.targetLineId, "target line id"],
    [input.sourceMessageId, "source message id"],
    [input.actorId, "actor id"],
    [input.workspaceId, "workspace id"]
  ] as const) {
    if (value !== undefined) {
      validateId(value, label);
    }
  }
  if (typeof input.text !== "string") {
    throw new ConversationStoreError("validation_error", "Normalized event text must be a string.");
  }
}

function validateCreateBranchInput(input: CreateBranchInput): void {
  for (const [value, label] of [
    [input.sessionId, "session id"],
    [input.sourceEventId, "source event id"],
    [input.title, "branch title"],
    [input.goal, "branch goal"],
    [input.reason, "branch reason"],
    [input.createdBy, "branch creator"],
    [input.idempotencyKey, "idempotency key"]
  ] as const) {
    validateId(value, label);
  }
  if (input.id !== undefined) {
    validateId(input.id, "branch id");
  }
  if (input.parentMainlineId !== undefined) {
    validateId(input.parentMainlineId, "parent mainline id");
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateTransitionBranchInput(input: TransitionBranchInput): void {
  validateId(input.idempotencyKey, "idempotency key");
  validateTimestamp(input.createdAt, "createdAt");
}

function validateAppendLineEventInput(input: AppendLineEventInput): void {
  validateId(input.type, "event type");
  validateId(input.idempotencyKey, "idempotency key");
  for (const [value, label] of [
    [input.id, "line event id"],
    [input.sessionId, "session id"],
    [input.sourceNormalizedEventId, "normalized event id"],
    [input.sourceEventId, "source event id"],
    [input.causationEventId, "causation event id"],
    [input.correlationId, "correlation id"],
    [input.taskId, "task id"],
    [input.actorId, "actor id"]
  ] as const) {
    if (value !== undefined) {
      validateId(value, label);
    }
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateListLineEventsOptions(options: ListLineEventsOptions): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new ConversationStoreError("validation_error", "Event list limit must be a positive safe integer.");
  }
  for (const [value, label] of [
    [options.afterSequence, "afterSequence"],
    [options.beforeSequence, "beforeSequence"]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ConversationStoreError("validation_error", `${label} must be a non-negative safe integer.`);
    }
  }
}

function validateCreateBranchResultInput(input: CreateBranchResultInput): void {
  validateId(input.summary, "branch result summary");
  validateId(input.idempotencyKey, "idempotency key");
  if (input.id !== undefined) {
    validateId(input.id, "branch result id");
  }
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version <= 0)) {
    throw new ConversationStoreError("validation_error", "Branch result version must be a positive safe integer.");
  }
  if (input.sourceEventId !== undefined) {
    validateId(input.sourceEventId, "source event id");
  }
  if ((input.nextActions ?? []).some((action) => typeof action !== "string")) {
    throw new ConversationStoreError("validation_error", "Branch result next actions must be strings.");
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateMergeInput(input: PublishBranchResultInput): void {
  for (const [value, label] of [
    [input.resultId, "branch result id"],
    [input.id, "branch merge id"],
    [input.eventId, "mainline event id"],
    [input.branchEventId, "branch event id"],
    [input.idempotencyKey, "idempotency key"]
  ] as const) {
    if (value !== undefined) {
      validateId(value, label);
    }
  }
  validateTimestamp(input.createdAt, "createdAt");
}

function validateLocator(locator: ConversationSessionLocator): void {
  validateId(locator.platform, "platform");
  validateId(locator.provider, "provider");
  validateId(locator.channelId, "channel id");
  validateId(locator.conversationId, "conversation id");
  if (!LOCATOR_TYPES.has(locator.conversationType)) {
    throw new ConversationStoreError(
      "validation_error",
      `Unsupported conversation type "${locator.conversationType}".`
    );
  }
}

function resolveSessionId(input: CreateSessionInput): string | undefined {
  return input.id ?? input.sessionId;
}

function locatorsEqual(
  left: ConversationSessionLocator | undefined,
  right: ConversationSessionLocator | undefined
): boolean {
  return (
    left?.platform === right?.platform &&
    left?.provider === right?.provider &&
    left?.channelId === right?.channelId &&
    left?.conversationType === right?.conversationType &&
    left?.conversationId === right?.conversationId
  );
}

function validateId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConversationStoreError("validation_error", `${label} must be a non-empty string.`);
  }
}

function validateTimestamp(value: string | undefined, label: string, required = false): void {
  if (value === undefined) {
    if (required) {
      throw new ConversationStoreError("validation_error", `${label} is required.`);
    }
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConversationStoreError("validation_error", `${label} must be a non-empty string.`);
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isSqliteConstraintError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

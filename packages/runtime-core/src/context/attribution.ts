import { getTextContent, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { ConversationBranch, NormalizedEvent } from "../conversation/types.js";
import type { ConversationStore } from "../conversation/store.js";
import { conversationTypeFromEvent, normalizeMessageId } from "./session.js";
import type { TranscriptStore } from "../transcript/types.js";

/**
 * 当前输入的交互性质
 */
export type InteractionNature =
  | "social"
  | "conversation_continue"
  | "question"
  | "task_request"
  | "task_followup"
  | "result_feedback"
  | "correction"
  | "topic_shift"
  | "command";

/**
 * 上下文归属动作
 */
export type ContextAttributionAction = "mainline" | "continue" | "resume";

/**
 * 参与归属比较的候选分支
 */
export interface ContextAttributionCandidate {
  readonly lineId: string;
  readonly score: number;
  readonly signals: readonly string[];
}

/**
 * 一次可追踪的上下文归属决定
 */
export interface ContextAttributionDecision {
  readonly sessionId: string;
  readonly nature: InteractionNature;
  readonly action: ContextAttributionAction;
  readonly targetLineId?: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly candidates: readonly ContextAttributionCandidate[];
}

/**
 * 上下文归属器的输入
 */
export interface ContextAttributionInput {
  readonly event: SynapseChannelEvent;
  readonly provider: string;
  readonly sessionId: string;
  readonly explicitTargetLineId?: string;
}

/**
 * 在消息落到 Line 前解析其语义归属
 */
export interface ContextAttributor {
  /** 判断频道事件应归属的会话线 */
  attribute(input: ContextAttributionInput): Promise<ContextAttributionDecision>;
}

/**
 * 轻量归属器的配置
 */
export interface ContextAttributorLiteOptions {
  readonly conversationStore: ConversationStore;
  readonly transcriptStore: TranscriptStore;
  readonly continuityWindowMs?: number;
  readonly semanticThreshold?: number;
  readonly ambiguityMargin?: number;
}

/**
 * 组合强关联规则和轻量语义评分的默认归属器
 */
export class ContextAttributorLite implements ContextAttributor {
  readonly #conversationStore: ConversationStore;
  readonly #transcriptStore: TranscriptStore;
  readonly #continuityWindowMs: number;
  readonly #semanticThreshold: number;
  readonly #ambiguityMargin: number;

  /**
   * 创建轻量上下文归属器
   */
  constructor(options: ContextAttributorLiteOptions) {
    this.#conversationStore = options.conversationStore;
    this.#transcriptStore = options.transcriptStore;
    this.#continuityWindowMs = options.continuityWindowMs ?? 10 * 60_000;
    this.#semanticThreshold = options.semanticThreshold ?? 0.46;
    this.#ambiguityMargin = options.ambiguityMargin ?? 0.12;
  }

  /**
   * 基于强关联信号与语义评分判断上下文归属
   */
  async attribute(input: ContextAttributionInput): Promise<ContextAttributionDecision> {
    const text = input.event.message === undefined ? "" : getTextContent(input.event.message).trim();
    const nature = classifyInteractionNature(text, input.event);
    const session = await this.#conversationStore.getSession(input.sessionId);
    if (session === undefined) {
      return mainlineDecision(input.sessionId, nature, "session_created_by_incoming_event");
    }

    const replay = await this.#findReplay(input);
    if (replay !== undefined) {
      return decisionForLine(session.mainlineId, replay.lineId, input.sessionId, nature, 1, [
        "normalized_event_replay"
      ]);
    }

    if (input.explicitTargetLineId !== undefined) {
      const line = await this.#conversationStore.getLine(input.explicitTargetLineId);
      if (line === undefined || line.sessionId !== input.sessionId) {
        throw new Error(`Explicit context line "${input.explicitTargetLineId}" does not belong to the session`);
      }
      return decisionForLine(session.mainlineId, line.id, input.sessionId, nature, 1, ["explicit_target_line"]);
    }

    const replyLineId = await this.#resolveReplyLine(input);
    if (replyLineId !== undefined) {
      return decisionForLine(session.mainlineId, replyLineId, input.sessionId, nature, 0.99, ["reply_relation"]);
    }

    const branches = await this.#conversationStore.listBranches(input.sessionId, {
      statuses: ["created", "active", "blocked", "inactive", "completed"]
    });
    if (branches.length === 0) {
      return mainlineDecision(input.sessionId, nature, "no_branch_candidate");
    }

    const latest = await this.#latestNormalizedEvent(input.sessionId);
    const recentBranch =
      latest === undefined || latest.lineId === session.mainlineId
        ? undefined
        : branches.find((branch) => branch.id === latest.lineId);
    if (
      latest !== undefined &&
      recentBranch !== undefined &&
      withinContinuityWindow(latest, input.event.receivedAt, this.#continuityWindowMs) &&
      nature !== "topic_shift"
    ) {
      return {
        sessionId: input.sessionId,
        nature,
        action: "continue",
        targetLineId: recentBranch.id,
        confidence: 0.78,
        reasons: ["recent_branch_continuity"],
        candidates: [
          {
            lineId: recentBranch.id,
            score: 0.78,
            signals: ["recent_branch_continuity"]
          }
        ]
      };
    }

    const candidates = await Promise.all(
      branches.map((branch) => this.#scoreBranch(branch, text, recentBranch?.id === branch.id))
    );
    const ranked = candidates.toSorted((left, right) => right.score - left.score);
    const first = ranked[0];
    const second = ranked[1];
    if (
      first === undefined ||
      first.score < this.#semanticThreshold ||
      (second !== undefined && first.score - second.score < this.#ambiguityMargin)
    ) {
      return {
        ...mainlineDecision(
          input.sessionId,
          nature,
          first === undefined || first.score < this.#semanticThreshold
            ? "semantic_match_below_threshold"
            : "semantic_candidates_ambiguous"
        ),
        candidates: ranked.slice(0, 3)
      };
    }

    return {
      sessionId: input.sessionId,
      nature,
      action: recentBranch?.id === first.lineId ? "continue" : "resume",
      targetLineId: first.lineId,
      confidence: first.score,
      reasons: first.signals,
      candidates: ranked.slice(0, 3)
    };
  }

  async #findReplay(input: ContextAttributionInput): Promise<NormalizedEvent | undefined> {
    const sourceIds = new Set(
      [input.event.id, input.event.message?.id].filter((value): value is string => value !== undefined)
    );
    return (await this.#conversationStore.listNormalizedEvents(input.sessionId)).find(
      (event) => event.sourceEventType === input.event.eventType && sourceIds.has(event.sourceEventId)
    );
  }

  async #resolveReplyLine(input: ContextAttributionInput): Promise<string | undefined> {
    const reply = input.event.message?.replyTo;
    if (reply?.eventId !== undefined) {
      const directEvent = await this.#conversationStore.getEvent(reply.eventId);
      if (directEvent?.sessionId === input.sessionId) {
        return directEvent.lineId;
      }
      const normalized = (await this.#conversationStore.listNormalizedEvents(input.sessionId)).find(
        (event) => event.sourceEventId === reply.eventId || event.id === reply.eventId
      );
      if (normalized !== undefined) {
        return normalized.lineId;
      }
    }

    const externalMessageId = normalizeMessageId(reply?.messageId ?? input.event.triggerHint?.replyTargetMessageId);
    if (externalMessageId === undefined || this.#transcriptStore.findByExternalMessageId === undefined) {
      return undefined;
    }
    const transcript = await this.#transcriptStore.findByExternalMessageId({
      platform: input.event.platform,
      provider: input.provider,
      channelId: input.event.channelId,
      conversationType: conversationTypeFromEvent(input.event),
      conversationId: input.event.conversation.id,
      externalMessageId
    });
    return transcript?.sessionId === input.sessionId ? transcript.lineId : undefined;
  }

  async #latestNormalizedEvent(sessionId: string): Promise<NormalizedEvent | undefined> {
    return (await this.#conversationStore.listNormalizedEvents(sessionId)).at(-1);
  }

  async #scoreBranch(
    branch: ConversationBranch,
    text: string,
    isRecent: boolean
  ): Promise<ContextAttributionCandidate> {
    const state = await this.#conversationStore.reconstructLineState(branch.id);
    const nodes = await this.#conversationStore.listNodes(branch.id, { limit: 3 });
    const candidateText = [
      branch.title,
      branch.goal,
      branch.reason,
      JSON.stringify(state.state),
      ...nodes.map((node) => node.title)
    ].join("\n");
    const semanticScore = lexicalSimilarity(text, candidateText);
    const recencyBonus = isRecent ? 0.12 : 0;
    const activeBonus = branch.status === "active" || branch.status === "created" ? 0.04 : 0;
    const score = Math.min(0.98, semanticScore + recencyBonus + activeBonus);
    const signals = ["branch_semantic_match"];
    if (isRecent) {
      signals.push("recent_branch_bonus");
    }
    if (activeBonus > 0) {
      signals.push("active_branch_bonus");
    }
    return {
      lineId: branch.id,
      score,
      signals
    };
  }
}

/**
 * 使用确定性规则识别当前输入的交互性质
 */
export function classifyInteractionNature(text: string, event?: SynapseChannelEvent): InteractionNature {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith("/")) {
    return "command";
  }
  if (/^(你好|您好|嗨|hello|hi|谢谢|感谢)[呀啊\s!！]*$/iu.test(normalized)) {
    return "social";
  }
  if (/(不是|不对|修正|改一下|纠正|调整|wrong|incorrect|actually)/iu.test(normalized)) {
    return "correction";
  }
  if (/(换个话题|另外一个|另一个问题|新话题|unrelated|new topic)/iu.test(normalized)) {
    return "topic_shift";
  }
  if (
    event?.message?.replyTo !== undefined &&
    /(继续|再看|补充|重试|调整|修改|follow up|continue|retry)/iu.test(normalized)
  ) {
    return "task_followup";
  }
  if (/(看看|检查|分析|实现|执行|生成|写一份|运行|调查|review|inspect|analy[sz]e|implement|run)/iu.test(normalized)) {
    return "task_request";
  }
  if (/[?？]$/.test(normalized)) {
    return "question";
  }
  return "conversation_continue";
}

function decisionForLine(
  mainlineId: string,
  lineId: string,
  sessionId: string,
  nature: InteractionNature,
  confidence: number,
  reasons: readonly string[]
): ContextAttributionDecision {
  return lineId === mainlineId
    ? mainlineDecision(sessionId, nature, reasons[0] ?? "mainline")
    : {
        sessionId,
        nature,
        action: "resume",
        targetLineId: lineId,
        confidence,
        reasons,
        candidates: [
          {
            lineId,
            score: confidence,
            signals: reasons
          }
        ]
      };
}

function mainlineDecision(sessionId: string, nature: InteractionNature, reason: string): ContextAttributionDecision {
  return {
    sessionId,
    nature,
    action: "mainline",
    confidence: 1,
    reasons: [reason],
    candidates: []
  };
}

function withinContinuityWindow(previous: NormalizedEvent, receivedAt: string, continuityWindowMs: number): boolean {
  const previousTime = Date.parse(previous.receivedAt);
  const currentTime = Date.parse(receivedAt);
  return (
    Number.isFinite(previousTime) &&
    Number.isFinite(currentTime) &&
    currentTime >= previousTime &&
    currentTime - previousTime <= continuityWindowMs
  );
}

function lexicalSimilarity(query: string, candidate: string): number {
  const queryTerms = terms(query);
  const candidateTerms = terms(candidate);
  if (queryTerms.size === 0 || candidateTerms.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) {
      overlap += 1;
    }
  }
  return overlap / Math.sqrt(queryTerms.size * candidateTerms.size);
}

function terms(value: string): ReadonlySet<string> {
  const normalized = value.toLowerCase();
  const result = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_-]{2,}/gu) ?? []) {
    result.add(word);
  }
  for (const segment of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      result.add(segment.slice(index, index + 2));
    }
  }
  return result;
}

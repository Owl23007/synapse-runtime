import type { AgentRequest } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { ToolCallReplayRequest, ToolCallReplayResolution } from "@synapse/runtime-tool-runtime";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeMessageId,
  type AcceptedNormalizedEvent,
  type ConversationStore,
  type EventProcessState,
  type EventProcessStore,
  type LineEvent,
  type OutputPolicy,
  type WorkspaceRef
} from "../context.js";
import type { RunRecorder } from "../trace/recorder.js";
import type { RuntimeDelivery } from "./delivery.js";
import { recordPayload, stringifyAgentOutput } from "./event-records.js";
import { getText, textMessage } from "./message-utils.js";
import type { RuntimeEventScope, RuntimeTrace } from "./types.js";

/** 恢复分类独立于 RunTrace 与平台回执，不能将它们合并为一个状态 */
export type RecoveryStatus = Exclude<EventProcessState["status"], "processing"> | "send_uncertain";
interface RecoveryOptions {
  readonly conversationStore: ConversationStore;
  readonly eventProcessStore: EventProcessStore;
  readonly recorders: ReadonlyMap<string, RunRecorder>;
  readonly traces: RuntimeTrace[];
  readonly agentId: string;
  readonly delivery: RuntimeDelivery;
}

/** 根据持久业务事实恢复或阻断执行，不直接访问具体存储或外部平台 */
export class RuntimeRecovery {
  /** 注入会话与交付用例，保持跨 Run 的持久语义 */
  constructor(private readonly options: RecoveryOptions) {}
  /** 恢复已持久输出或阻断未知投递，返回 true 时禁止重新执行 Agent */
  async resume(input: {
    readonly event: SynapseChannelEvent;
    readonly request: AgentRequest;
    readonly scope: RuntimeEventScope;
    readonly processState: EventProcessState;
    readonly recoveryStatus: RecoveryStatus;
    readonly commandOutput: SynapseMessage | undefined;
    readonly workspace: WorkspaceRef;
    readonly outputPolicy: OutputPolicy;
    readonly processStateId: string | undefined;
  }): Promise<boolean> {
    const { event, request, scope, processState, commandOutput, workspace, outputPolicy, processStateId } = input;
    let recoveryStatus = input.recoveryStatus;
    let recoveredOutput =
      parseAgentOutput(processState.agentOutputJson) ??
      (processState.agentOutputText === undefined ? undefined : textMessage(processState.agentOutputText));
    if (recoveredOutput === undefined) {
      const completedAgentEvent = await this.#findCompletedAgentEvent(scope.accepted);
      const persistedOutput = completedAgentEvent === undefined ? undefined : agentOutputFromEvent(completedAgentEvent);
      if (persistedOutput !== undefined) {
        recoveredOutput = persistedOutput;
        if (recoveryStatus === "received") {
          recoveryStatus = "agent_completed";
        }
        await this.options.eventProcessStore.update(processState.id, {
          status: "processing",
          agentOutputText: getText(persistedOutput),
          agentOutputJson: stringifyAgentOutput(persistedOutput)
        });
      }
    }
    if (recoveredOutput !== undefined && commandOutput === undefined) {
      await this.#ensureCompletedAgentEvent(scope.accepted, recoveredOutput, event.id);
    }

    if (recoveryStatus === "send_uncertain") {
      const assistantEvent = await this.#findAssistantEvent(scope.accepted);
      if (assistantEvent === undefined || recoveredOutput === undefined) {
        throw new Error(`Uncertain delivery for "${scope.accepted.event.id}" is missing its persisted output.`);
      }
      const recoveredRunId = scope.runId ?? `recovered-${event.id}`;
      await this.options.delivery.appendDeliveryEvent(
        { event, runId: recoveredRunId, conversation: scope.accepted },
        assistantEvent,
        "delivery_uncertain",
        {
          recovered: true,
          reason: "The previous process stopped after delivery started; output was not sent again."
        }
      );
      const output = this.options.delivery.applyResponsePolicy(recoveredOutput, outputPolicy, event.id, recoveredRunId);
      const assistant = await this.options.delivery.appendAssistantTranscript(
        event,
        output,
        scope.accepted,
        undefined,
        assistantEvent.id
      );
      await this.options.eventProcessStore.update(processState.id, {
        status: "completed",
        ...(assistant === undefined ? {} : { assistantMessageId: assistant.id }),
        errorJson: JSON.stringify({ phase: "send_uncertain" })
      });
      this.options.traces.push({
        eventId: event.id,
        status: "failed",
        reason: "delivery_outcome_uncertain",
        runId: recoveredRunId
      });
      return true;
    }

    if ((recoveryStatus === "agent_completed" || recoveryStatus === "send_failed") && recoveredOutput !== undefined) {
      const assistantEvent = await this.#findAssistantEvent(scope.accepted);
      if (assistantEvent !== undefined) {
        const delivered = await this.options.delivery.findSuccessfulDelivery(scope.accepted, assistantEvent);
        if (delivered !== undefined) {
          const recoveredRunId = scope.runId ?? `recovered-${event.id}`;
          this.options.recorders
            .get(recoveredRunId)
            ?.emit("response_sent", { recovered: true, externalMessageId: externalMessageIdFromDelivery(delivered) });
          const output = this.options.delivery.applyResponsePolicy(
            recoveredOutput,
            outputPolicy,
            event.id,
            recoveredRunId
          );
          const assistant = await this.options.delivery.appendAssistantTranscript(
            event,
            output,
            scope.accepted,
            externalMessageIdFromDelivery(delivered),
            assistantEvent.id
          );
          await this.options.eventProcessStore.update(processState.id, {
            status: "completed",
            ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
          });
          this.options.traces.push({ eventId: event.id, status: "succeeded", runId: recoveredRunId });
          return true;
        }
      }
      await this.options.delivery.sendOutput({
        event,
        request,
        runId: scope.runId ?? `recovered-${event.id}`,
        output: recoveredOutput,
        workspace,
        outputPolicy,
        processStateId,
        conversation: scope.accepted
      });
      return true;
    }

    if (recoveryStatus !== "send_succeeded") {
      return false;
    }

    if (recoveredOutput === undefined) {
      await this.options.eventProcessStore.update(processState.id, {
        status: "completed",
        errorJson: JSON.stringify({ error: "send_succeeded_without_output" })
      });
      this.options.traces.push({ eventId: event.id, status: "ignored", reason: "send_succeeded_without_output" });
      return true;
    }

    const recoveredRunId = scope.runId ?? `recovered-${event.id}`;
    const assistantEvent = await this.#findAssistantEvent(scope.accepted);
    if (assistantEvent === undefined) {
      throw new Error(`Persisted assistant event for "${scope.accepted.event.id}" does not exist.`);
    }
    const sendResult = parseSendResult(processState.sendResultJson);
    const delivered = await this.options.delivery.findSuccessfulDelivery(scope.accepted, assistantEvent);
    if (delivered === undefined) {
      await this.options.delivery.appendDeliveryEvent(
        { event, runId: recoveredRunId, conversation: scope.accepted },
        assistantEvent,
        "delivery_succeeded",
        {
          ...(sendResult?.messageId === undefined ? {} : { externalMessageId: sendResult.messageId }),
          recovered: true
        }
      );
    }
    const output = this.options.delivery.applyResponsePolicy(recoveredOutput, outputPolicy, event.id, recoveredRunId);
    const assistant = await this.options.delivery.appendAssistantTranscript(
      event,
      output,
      scope.accepted,
      sendResult?.messageId,
      assistantEvent.id
    );
    await this.options.eventProcessStore.update(processState.id, {
      status: "completed",
      ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
    });
    this.options.traces.push({ eventId: event.id, status: "succeeded", runId: recoveredRunId });
    this.options.recorders
      .get(recoveredRunId)
      ?.emit("response_sent", { recovered: true, externalMessageId: sendResult?.messageId });
    return true;
  }

  async #findAssistantEvent(conversation: AcceptedNormalizedEvent): Promise<LineEvent | undefined> {
    const events = await this.options.conversationStore.listEvents(conversation.lineEvent.lineId, {
      types: ["assistant_message"]
    });
    return events.find((event) => event.idempotencyKey === `assistant:${conversation.event.id}`);
  }

  async #findCompletedAgentEvent(conversation: AcceptedNormalizedEvent): Promise<LineEvent | undefined> {
    const events = await this.options.conversationStore.listEvents(conversation.lineEvent.lineId, {
      types: ["agent_run_completed"]
    });
    return events.findLast((event) => event.sourceEventId === conversation.lineEvent.id);
  }

  async #ensureCompletedAgentEvent(
    conversation: AcceptedNormalizedEvent,
    output: SynapseMessage,
    runtimeEventId: string
  ): Promise<LineEvent | undefined> {
    const completed = await this.#findCompletedAgentEvent(conversation);
    if (completed !== undefined) {
      return completed;
    }

    const startedEvents = await this.options.conversationStore.listEvents(conversation.lineEvent.lineId, {
      types: ["agent_run_started"]
    });
    const started = startedEvents.findLast((event) => event.sourceEventId === conversation.lineEvent.id);
    if (started === undefined) {
      return undefined;
    }
    const attemptId = agentAttemptIdFromEvent(started);
    if (attemptId === undefined) {
      return undefined;
    }

    return this.options.conversationStore.appendEvent(conversation.lineEvent.lineId, {
      type: "agent_run_completed",
      idempotencyKey: `agent-run:${conversation.event.sourceEventId}:${attemptId}:finished`,
      sourceEventId: conversation.lineEvent.id,
      causationEventId: conversation.lineEvent.id,
      correlationId: started.correlationId ?? attemptId,
      actorId: this.options.agentId,
      payload: {
        attemptId,
        runId: `recovered-${runtimeEventId}`,
        agentId: this.options.agentId,
        status: "succeeded",
        steps: [],
        output,
        recovered: true
      }
    });
  }

  /** 核对工具身份与持久终态，未决调用只能返回 started 而不能执行 */
  async replayToolCall(request: ToolCallReplayRequest): Promise<ToolCallReplayResolution> {
    const lineId = request.context.lineId;
    if (lineId === undefined) {
      return {
        status: "conflict",
        reason: `Durable tool call "${request.context.callId}" has no conversation line scope.`
      };
    }

    const events = await this.options.conversationStore.listEvents(lineId, {
      types: ["tool_call", "tool_result"]
    });
    const started = events.find((event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_started`);
    if (started === undefined) {
      return { status: "missing" };
    }
    const startedPayload = recordPayload(started);
    if (
      startedPayload?.callId !== request.context.callId ||
      startedPayload.name !== request.name ||
      !isDeepStrictEqual(startedPayload.input, request.input) ||
      started.taskId !== request.context.taskId
    ) {
      return {
        status: "conflict",
        reason: `Durable tool call "${request.context.callId}" conflicts with the replayed name, input, or task scope.`
      };
    }

    const succeeded = events.find(
      (event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_succeeded`
    );
    if (succeeded !== undefined) {
      return { status: "succeeded", output: recordPayload(succeeded)?.output };
    }
    const blocked = events.find((event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_blocked`);
    if (blocked !== undefined) {
      const reason = recordPayload(blocked)?.reason;
      return {
        status: "blocked",
        reason: typeof reason === "string" ? reason : "The durable permission decision blocked this tool call."
      };
    }
    const failed = events.find((event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_failed`);
    if (failed !== undefined) {
      return { status: "failed", error: recordPayload(failed)?.error };
    }
    await this.options.conversationStore.appendEvent(lineId, {
      type: "tool_result",
      idempotencyKey: `tool:${request.context.callId}:tool_call_uncertain`,
      ...(started.sourceEventId === undefined ? {} : { sourceEventId: started.sourceEventId }),
      causationEventId: started.id,
      correlationId: started.correlationId ?? request.context.attemptId ?? request.context.runId,
      ...(started.taskId === undefined ? {} : { taskId: started.taskId }),
      actorId: request.context.userId,
      payload: {
        callId: request.context.callId,
        name: request.name,
        ...(request.input === undefined ? {} : { input: request.input }),
        status: "uncertain",
        reason: "The tool call started previously, but no durable outcome was recorded; it was not executed again."
      }
    });
    return { status: "started" };
  }
}

function parseSendResult(value: string | undefined): { readonly messageId?: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { readonly messageId?: unknown; readonly externalMessageId?: unknown };
    const messageId = normalizeMessageId(parsed.messageId ?? parsed.externalMessageId);
    return messageId === undefined ? {} : { messageId };
  } catch {
    return undefined;
  }
}

function parseAgentOutput(value: string | undefined): SynapseMessage | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SynapseMessage>;
    return typeof parsed.type === "string" && Array.isArray(parsed.segments) ? (parsed as SynapseMessage) : undefined;
  } catch {
    return undefined;
  }
}

function processPhase(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { readonly phase?: unknown };
    return typeof parsed.phase === "string" ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

/** 从原始处理状态还原发送阶段，未决发送不得降级为可重试失败 */
export function recoveryStatusFromProcess(process: EventProcessState): RecoveryStatus {
  if (process.status !== "processing") {
    return process.status;
  }

  if (processPhase(process.errorJson) === "send_started") {
    return "send_uncertain";
  }

  if (process.sendResultJson !== undefined) {
    return "send_succeeded";
  }

  return process.agentOutputJson !== undefined || process.agentOutputText !== undefined
    ? "agent_completed"
    : "received";
}

function agentOutputFromEvent(event: LineEvent): SynapseMessage | undefined {
  if (typeof event.payload !== "object" || event.payload === null || !("output" in event.payload)) {
    return undefined;
  }
  const output = (event.payload as { readonly output?: unknown }).output;
  if (
    typeof output !== "object" ||
    output === null ||
    !("type" in output) ||
    typeof output.type !== "string" ||
    !("segments" in output) ||
    !Array.isArray(output.segments)
  ) {
    return undefined;
  }
  return output as SynapseMessage;
}

function agentAttemptIdFromEvent(event: LineEvent): string | undefined {
  if (typeof event.payload === "object" && event.payload !== null && "attemptId" in event.payload) {
    const attemptId = (event.payload as { readonly attemptId?: unknown }).attemptId;
    if (typeof attemptId === "string" && attemptId.length > 0) {
      return attemptId;
    }
  }
  return event.correlationId;
}

function externalMessageIdFromDelivery(event: LineEvent): string | undefined {
  if (typeof event.payload !== "object" || event.payload === null || !("externalMessageId" in event.payload)) {
    return undefined;
  }
  return normalizeMessageId((event.payload as { readonly externalMessageId?: unknown }).externalMessageId);
}

/** 兼容历史处理中事件的短期并发保护窗口 */
export function isFreshProcessState(updatedAt: string): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return Date.now() - updatedAtMs < 5 * 60 * 1000;
}

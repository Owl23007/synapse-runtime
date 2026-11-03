import { executeChannelAction, type ChannelRegistry } from "@synapse/runtime-channel";
import type { AgentRequest } from "@synapse/runtime-conversation";
import {
  messageSendAction,
  type ChannelActionResult,
  type SynapseChannelEvent,
  type SynapseMessage
} from "@synapse/runtime-protocol";
import type { ToolRuntime } from "@synapse/runtime-tool-runtime";
import {
  buildSourceEventId,
  conversationTypeFromEvent,
  normalizeMessageId,
  type AcceptedNormalizedEvent,
  type ConversationStore,
  type EventProcessStore,
  type LineEvent,
  type OutputPolicy,
  type TranscriptStore,
  type WorkspaceRef
} from "../context.js";
import type { ResponsePolicy } from "../output/index.js";
import type { RunRecorder } from "../trace/recorder.js";
import { stringifyAgentOutput } from "./event-records.js";
import { withAbort } from "./execution-budget.js";
import {
  channelSendPermission,
  conservativeResponse,
  getText,
  targetFromEvent,
  withReplyContext
} from "./message-utils.js";
import type { RuntimeCoreLogger, RuntimeCoreOptions, RuntimeTrace } from "./types.js";
import type { ExecutionIntent } from "../execution/types.js";
import type { ExecutionStore } from "../execution/store.js";

interface DeliveryOptions {
  readonly agentId: string;
  readonly channels: ChannelRegistry;
  readonly tools: ToolRuntime;
  readonly conversationStore: ConversationStore;
  readonly eventProcessStore: EventProcessStore;
  readonly transcriptStore: TranscriptStore;
  readonly contextEnabled: boolean;
  readonly responsePolicy: ResponsePolicy;
  readonly logger: RuntimeCoreLogger | undefined;
  readonly recorders: ReadonlyMap<string, RunRecorder>;
  readonly controllers: ReadonlyMap<string, AbortController>;
  readonly traces: RuntimeTrace[];
  readonly materializeMessage: RuntimeCoreOptions["materializeMessage"];
  readonly selectMessage: RuntimeCoreOptions["selectMessage"];
  readonly publishArtifacts: RuntimeCoreOptions["publishArtifacts"];
  readonly prepareDelivery: RuntimeCoreOptions["prepareDelivery"];
}

/** 结果交付用例，持久发送意图之后的未知副作用不能自动重试 */
export class RuntimeDelivery {
  /** 只依赖领域能力和应用注入的交付端口 */
  constructor(private readonly options: DeliveryOptions) {}

  /** 后台结果使用授权中的固定目标，操作回执先于终态，未知发送不会自动重试 */
  async sendIntent(
    intent: ExecutionIntent,
    message: SynapseMessage,
    store: ExecutionStore,
    signal: AbortSignal
  ): Promise<void> {
    store.validateIntent(intent);
    const grant = store.authorize(intent.grantId);
    const recorder = this.options.recorders.get(intent.runId);
    const id = `delivery:${intent.id}`;
    const previous = store.operation(id);
    if (previous?.state === "succeeded") {
      recorder?.emit("response_sent", previous.result);
      return;
    }
    if (previous && !(previous.state === "started" && previous.effect !== "external")) {
      recorder?.fail("uncertain", "delivery_reconciliation_required", "先核对已有交付操作，未重新发送");
      return;
    }
    const event = intent.payload.event;
    const target = targetFromEvent(event);
    if (event.platform !== "native") {
      const permission = await this.options.tools.decidePermission({
        action: channelSendPermission(event.platform, target),
        resource: `${event.platform}:${grant.source.channelId}:${grant.source.conversationId}`,
        subject: grant.principalId
      });
      if (permission.decision !== "allow") {
        recorder?.fail("blocked", "notification_denied", permission.reason ?? "通知未授权");
        return;
      }
    }
    signal.throwIfAborted();
    store.validateIntent(intent);
    if (event.platform === "native") {
      if (!grant.sessionId) throw new Error("Native notification requires an authorized session");
      const session = await this.options.conversationStore.getSession(grant.sessionId);
      if (!session || session.workspaceId !== grant.workspaceId) throw new Error("Notification session scope invalid");
      await this.options.conversationStore.appendEvent(session.mainlineId, {
        type: "assistant_message",
        idempotencyKey: id,
        actorId: this.options.agentId,
        correlationId: intent.runId,
        payload: { message, text: getText(message), runId: intent.runId }
      });
      store.startOperation(intent.runId, id, "delivery", message, "transactional");
      store.receipt(id, "succeeded", { destination: "native" });
      recorder?.emit("response_sent", { destination: "native" });
      return;
    }
    const channel = this.options.channels.get(grant.source.channelId);
    if (!channel) throw new Error("Authorized channel unavailable");
    // 自主通知首版只接受文本，工件需要走当前交互的受控选择和交付链路
    if (message.segments.some((segment) => segment.type !== "text"))
      throw new Error("Autonomous notification supports text only");
    store.startOperation(intent.runId, id, "delivery", message);
    recorder?.emit("response_sending", { target, output: message });
    try {
      const operation = executeChannelAction(
        channel,
        messageSendAction({
          actionId: id,
          channelId: grant.source.channelId,
          target,
          message,
          conversation: event.conversation,
          idempotencyKey: id
        })
      );
      const receipt = await withAbort(operation, signal);
      store.receipt(
        id,
        receipt.status === "succeeded" ? "succeeded" : receipt.status === "uncertain" ? "uncertain" : "failed",
        receipt
      );
      recorder?.emit(
        receipt.status === "succeeded"
          ? "response_sent"
          : receipt.status === "uncertain"
            ? "response_send_uncertain"
            : "response_send_failed",
        receipt
      );
    } catch (error) {
      store.receipt(id, "uncertain", { message: "发送结果未确认" });
      recorder?.emit("response_send_uncertain", { message: String(error) });
    }
  }
  /** 仅依据持久成功事实判断是否已交付 */
  async findSuccessfulDelivery(
    conversation: AcceptedNormalizedEvent,
    assistantEvent: LineEvent
  ): Promise<LineEvent | undefined> {
    const deliveryEvents = await this.options.conversationStore.listEvents(conversation.mainline.id, {
      types: ["delivery_succeeded"]
    });
    return deliveryEvents.find((delivery) => delivery.sourceEventId === assistantEvent.id);
  }

  /** 依次准备输出、检查权限、持久发送意图并记录平台结果 */
  async sendOutput(input: {
    readonly event: SynapseChannelEvent;
    readonly request: AgentRequest;
    readonly runId: string;
    readonly output: SynapseMessage;
    readonly workspace: WorkspaceRef | undefined;
    readonly outputPolicy: OutputPolicy | undefined;
    readonly processStateId: string | undefined;
    readonly conversation: AcceptedNormalizedEvent;
  }): Promise<void> {
    // 恢复路径同样经过这里，图提交可按原事件补齐且不会触发第二次群文件上传
    const signal = (
      this.options.controllers.get(input.runId) ?? this.options.controllers.get(`event:${input.conversation.event.id}`)
    )?.signal;
    signal?.throwIfAborted();
    const channel = this.options.channels.get(input.event.channelId);
    const selectedOutput = this.options.selectMessage?.(input.conversation.session.id, input.output) ?? input.output;
    if (input.workspace)
      await this.options.publishArtifacts?.({
        sessionId: input.conversation.session.id,
        runId: input.runId,
        workspaceId: input.workspace.id,
        message: selectedOutput
      });
    const presented = this.applyResponsePolicy(selectedOutput, input.outputPolicy, input.event.id, input.runId);
    // 仅支持文本的既有频道保留文本回退，媒体频道不能静默丢弃已确认附件
    const output: SynapseMessage =
      channel?.getCapabilities().capabilities["message.media"]?.status === "unsupported"
        ? { ...presented, type: "text", segments: [{ type: "text", text: getText(presented) }] }
        : presented;
    if (
      output !== presented &&
      presented.segments.some((segment) => ["image", "file", "audio", "video", "sticker"].includes(segment.type))
    ) {
      this.options.logger?.warn("Runtime channel does not support media; delivering text fallback.", {
        eventId: input.event.id,
        channelId: input.event.channelId
      });
    }
    const assistantEvent = await this.options.conversationStore.appendEvent(input.conversation.lineEvent.lineId, {
      type: "assistant_message",
      idempotencyKey: `assistant:${input.conversation.event.id}`,
      sourceEventId: input.conversation.lineEvent.id,
      causationEventId: input.conversation.lineEvent.id,
      correlationId: input.conversation.event.id,
      actorId: this.options.agentId,
      payload: {
        role: "assistant",
        message: output,
        text: getText(output)
      }
    });

    if (input.event.platform === "native") {
      // 本地结果以持久消息为交付事实，不经过外部发送权限，也不自动发布分支
      await this.appendDeliveryEvent(input, assistantEvent, "delivery_succeeded", {
        destination: "native",
        assistantEventId: assistantEvent.id
      });
      await this.appendAssistantTranscript(input.event, output, input.conversation, undefined, assistantEvent.id);
      if (input.processStateId !== undefined)
        await this.options.eventProcessStore.update(input.processStateId, {
          status: "completed",
          agentOutputText: getText(output),
          agentOutputJson: stringifyAgentOutput(output)
        });
      this.options.traces.push({ eventId: input.event.id, status: "succeeded", runId: input.runId });
      return;
    }

    const target = targetFromEvent(input.event);

    if (channel === undefined) {
      await this.appendDeliveryEvent(input, assistantEvent, "delivery_failed", {
        error: `Channel "${input.event.channelId}" is not registered.`
      });
      if (input.processStateId !== undefined) {
        await this.options.eventProcessStore.update(input.processStateId, {
          status: "completed",
          errorJson: JSON.stringify({ error: `Channel "${input.event.channelId}" is not registered.` })
        });
      }
      this.options.traces.push({
        eventId: input.event.id,
        status: "failed",
        reason: `Channel "${input.event.channelId}" is not registered.`
      });
      this.options.logger?.error("Runtime send failed because channel is not registered.", {
        eventId: input.event.id,
        runId: input.runId,
        channelId: input.event.channelId
      });
      return;
    }

    if (input.processStateId !== undefined) {
      /**
       * 在频道发送前保存完整输出以便崩溃恢复时跳过重复智能体执行
       */
      await this.options.eventProcessStore.update(input.processStateId, {
        agentOutputText: getText(input.output),
        agentOutputJson: stringifyAgentOutput(input.output)
      });
    }

    let permission = await this.options.tools.decidePermission({
      action: channelSendPermission(input.event.platform, target),
      resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
      subject: input.request.userId,
      metadata: {
        eventId: input.event.id,
        runId: input.runId,
        conversationKind: input.event.conversation.kind
      }
    });

    if (
      permission.decision === "allow" &&
      output.segments.some((segment) => ["image", "file", "audio", "video", "sticker"].includes(segment.type))
    ) {
      permission = await this.options.tools.decidePermission({
        action: `channel.${input.event.platform}.send_media`,
        resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
        subject: input.request.userId
      });
    }

    if (
      permission.decision === "allow" &&
      target.type === "group" &&
      output.segments.some((segment) => segment.type === "file")
    ) {
      permission = await this.options.tools.decidePermission({
        action: `channel.${input.event.platform}.upload_group_file`,
        resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
        subject: input.request.userId
      });
    }

    this.options.recorders
      .get(input.runId)
      ?.emit(permission.decision === "allow" ? "permission_allowed" : "permission_blocked", {
        ...permission,
        purpose: "response"
      });
    if (permission.decision !== "allow") {
      const reason = permission.reason ?? `Permission decision was "${permission.decision}".`;
      await this.appendDeliveryEvent(input, assistantEvent, "delivery_blocked", {
        decision: permission.decision,
        reason
      });
      if (input.processStateId !== undefined) {
        await this.options.eventProcessStore.update(input.processStateId, {
          status: "completed",
          errorJson: JSON.stringify({ error: reason })
        });
      }
      this.options.traces.push({
        eventId: input.event.id,
        status: "blocked",
        reason,
        runId: input.runId
      });
      return;
    }

    let result: ChannelActionResult;
    if (input.processStateId === undefined) {
      throw new Error("Event process state is required before channel delivery.");
    }
    signal?.throwIfAborted();
    await this.options.eventProcessStore.update(input.processStateId, {
      status: "processing",
      errorJson: JSON.stringify({ phase: "send_started", runId: input.runId })
    });
    this.options.recorders.get(input.runId)?.emit("response_sending", { target, output });
    /**
     * send_started 之后的异常按投递结果不确定处理以避免自动重复发送
     */
    let deliveryFailureKnown = false;
    try {
      signal?.throwIfAborted();
      let deliveryMessage = output;
      if (this.options.prepareDelivery) {
        const preparation = this.options.prepareDelivery({
          sessionId: input.conversation.session.id,
          channelId: input.event.channelId,
          conversationId: input.event.conversation.id,
          conversationKind: input.event.conversation.kind,
          message: output,
          ...(signal === undefined ? {} : { signal }),
          observe: (type, data) => this.options.recorders.get(input.runId)?.emit(type, data)
        });
        const prepared = await (signal ? withAbort(preparation, signal) : preparation);
        if (prepared.status !== "ready") {
          deliveryFailureKnown = prepared.status === "failed";
          throw new Error(prepared.error);
        }
        deliveryMessage = prepared.message;
      }
      signal?.throwIfAborted();
      const delivery = executeChannelAction(
        channel,
        messageSendAction({
          actionId: `message.send:${input.event.id}`,
          channelId: input.event.channelId,
          target,
          message: withReplyContext(
            this.options.materializeMessage?.(input.conversation.session.id, deliveryMessage) ?? deliveryMessage,
            input.event
          ),
          conversation: input.event.conversation,
          idempotencyKey: `send:${input.event.id}`
        })
      );
      result = await (signal ? withAbort(delivery, signal) : delivery);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Channel send threw an unknown error.";
      await this.appendDeliveryEvent(input, assistantEvent, "delivery_failed", {
        error: reason,
        thrown: !deliveryFailureKnown
      });
      await this.options.eventProcessStore.update(input.processStateId, {
        status: deliveryFailureKnown ? "send_failed" : "completed",
        errorJson: JSON.stringify({ phase: deliveryFailureKnown ? "send_failed" : "send_uncertain", error: reason })
      });
      this.options.traces.push({
        eventId: input.event.id,
        status: "failed",
        reason,
        runId: input.runId
      });
      return;
    }

    if (result.status !== "succeeded") {
      const reason = result.error;
      await this.appendDeliveryEvent(
        input,
        assistantEvent,
        result.status === "uncertain" ? "delivery_uncertain" : "delivery_failed",
        {
          error: reason,
          errorCode: result.errorCode,
          retryable: result.retryable
        }
      );
      if (input.processStateId !== undefined) {
        await this.options.eventProcessStore.update(input.processStateId, {
          status: result.status === "uncertain" ? "completed" : "send_failed",
          errorJson: JSON.stringify({
            phase: result.status === "uncertain" ? "send_uncertain" : "send_failed",
            error: reason,
            errorCode: result.errorCode
          })
        });
      }
      this.options.traces.push({
        eventId: input.event.id,
        status: "failed",
        reason,
        runId: input.runId
      });
      return;
    }

    if (input.processStateId !== undefined) {
      await this.options.eventProcessStore.update(input.processStateId, {
        status: "send_succeeded",
        sendResultJson: JSON.stringify(result)
      });
    }
    await this.appendDeliveryEvent(input, assistantEvent, "delivery_succeeded", {
      artifactIds: output.segments.flatMap((part) =>
        (part.type === "file" || part.type === "image") && part.url?.startsWith("artifact://")
          ? [part.url.slice(11)]
          : []
      ),
      ...(result.messageId === undefined ? {} : { externalMessageId: result.messageId })
    });

    try {
      const assistant = await this.appendAssistantTranscript(
        input.event,
        output,
        input.conversation,
        result.messageId,
        assistantEvent.id
      );

      if (input.processStateId !== undefined) {
        await this.options.eventProcessStore.update(input.processStateId, {
          status: "completed",
          ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
        });
      }
    } catch (error) {
      this.options.logger?.warn("Runtime assistant transcript append failed after successful send.", {
        eventId: input.event.id,
        runId: input.runId,
        error: error instanceof Error ? error.message : "Unknown transcript error."
      });
    }

    this.options.traces.push({ eventId: input.event.id, status: "succeeded", runId: input.runId });
  }

  /** 保留 Line 交付事实先于 Run 投影的持久顺序 */
  async appendDeliveryEvent(
    input: {
      readonly event: SynapseChannelEvent;
      readonly runId: string;
      readonly conversation: AcceptedNormalizedEvent;
    },
    assistantEvent: LineEvent,
    type: "delivery_succeeded" | "delivery_failed" | "delivery_blocked" | "delivery_uncertain",
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    await this.options.conversationStore.appendEvent(input.conversation.mainline.id, {
      type,
      idempotencyKey: `${type}:${input.conversation.event.id}:${input.runId}`,
      sourceEventId: assistantEvent.id,
      causationEventId: assistantEvent.id,
      correlationId: input.conversation.event.id,
      actorId: this.options.agentId,
      payload: {
        runId: input.runId,
        ...payload
      }
    });
    const recorder = this.options.recorders.get(input.runId);
    if (type === "delivery_blocked")
      recorder?.fail("blocked", "response_blocked", String(payload.reason ?? "消息发送被权限阻止"), "response");
    else
      recorder?.emit(
        type === "delivery_succeeded"
          ? "response_sent"
          : type === "delivery_uncertain" || payload.thrown === true
            ? "response_send_uncertain"
            : "response_send_failed",
        payload
      );
  }

  /** 执行后置表达策略，失败时保留保守输出 */
  applyResponsePolicy(
    message: SynapseMessage,
    policy: OutputPolicy | undefined,
    eventId: string,
    runId: string
  ): SynapseMessage {
    if (policy === undefined) {
      return message;
    }

    try {
      return this.options.responsePolicy.apply(message, policy);
    } catch (error) {
      this.options.logger?.warn("Runtime response policy failed; using conservative truncation.", {
        eventId,
        runId,
        error: error instanceof Error ? error.message : "Unknown response policy error."
      });
      return conservativeResponse(message, policy);
    }
  }

  /** 将助手输出与已知平台消息身份登记到会话历史 */
  async appendAssistantTranscript(
    event: SynapseChannelEvent,
    output: SynapseMessage,
    conversation: AcceptedNormalizedEvent,
    externalMessageId?: string,
    lineEventId?: string
  ) {
    if (!this.options.contextEnabled) {
      return undefined;
    }

    const provider = conversation.event.provider;
    const normalizedExternalMessageId = normalizeMessageId(externalMessageId);
    return this.options.transcriptStore.append({
      sessionId: conversation.session.id,
      lineId: conversation.lineEvent.lineId,
      platform: event.platform,
      provider,
      channelId: event.channelId,
      conversationType: conversationTypeFromEvent(event),
      conversationId: event.conversation.id,
      sourceEventId: `${buildSourceEventId(event, provider)}:assistant`,
      role: "assistant",
      text: getText(output),
      message: output,
      eventType: "assistant_message",
      idempotencyKey: `assistant:${conversation.event.id}`,
      ...(lineEventId === undefined ? {} : { lineEventId }),
      ...(normalizedExternalMessageId === undefined ? {} : { externalMessageId: normalizedExternalMessageId }),
      createdAt: new Date().toISOString()
    });
  }
}

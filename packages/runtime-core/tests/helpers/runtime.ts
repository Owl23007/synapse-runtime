import { onTestFinished } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { RuntimeCore } from "../../src/index.js";
import { type ChannelAdapter, type ChannelEventHandler, type ChannelStatus } from "@synapse/runtime-channel";
import type { ChannelCapabilityProfile, ChannelActionTarget, ChannelOperationResult } from "@synapse/runtime-protocol";
import {
  textMessage,
  type MessageSegment,
  type SynapseChannelEvent,
  type SynapseMessage
} from "@synapse/runtime-protocol";
import {
  InMemoryConversationStore,
  InMemoryEventProcessStore,
  InMemoryTranscriptStore,
  type EventProcessBeginInput,
  type EventProcessState,
  type AcceptNormalizedEventInput,
  type IdentityResolver,
  type TranscriptAppendInput
} from "../../src/index.js";

/** 创建由当前用例持有的运行时，场景只需显式覆盖相关依赖 */
export function createRuntimeFixture(
  options: Pick<ConstructorParameters<typeof RuntimeCore>[0], "agent"> &
    Partial<ConstructorParameters<typeof RuntimeCore>[0]>
): RuntimeCore {
  const runtime = new RuntimeCore({
    channels: new InMemoryChannelRegistry(),
    conversation: new ConversationRouter({ groupTrigger: { mode: "always" }, privateTrigger: { mode: "always" } }),
    tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
    ...options
  });
  // 当前用例结束时等待在途工作完成，避免运行时观察者跨用例存活
  onTestFinished(() => runtime.dispose());
  return runtime;
}
/** 用真实事件订阅驱动运行时，并允许用例指定发送结果 */
export class MockChannelAdapter implements ChannelAdapter {
  readonly id = "qq-local";
  readonly type = "onebot11";
  readonly provider = "napcat";
  readonly #handlers = new Set<ChannelEventHandler>();
  readonly sent: Array<{ target: ChannelActionTarget; message: SynapseMessage }> = [];
  readonly sendResults: ChannelOperationResult[] = [];

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getStatus(): Promise<ChannelStatus> {
    return { state: "online", checkedAt: new Date(0).toISOString() };
  }

  getCapabilities(): ChannelCapabilityProfile {
    return {
      schemaVersion: "channel-protocol/v1",
      channelId: this.id,
      adapterType: this.type,
      observedAt: new Date().toISOString(),
      capabilities: {
        "message.send": { status: "supported", constraints: { targetTypes: ["private", "group"] } },
        "message.media": { status: "unsupported" },
        "message.delete": { status: "unsupported" },
        "file.upload": { status: "unsupported", constraints: { targetTypes: ["group"], maxFileSizeBytes: 10_485_760 } }
      }
    };
  }

  async sendMessage(target: ChannelActionTarget, message: SynapseMessage): Promise<ChannelOperationResult> {
    this.sent.push({ target, message });
    return this.sendResults.shift() ?? { status: "succeeded", messageId: "sent-1" };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async emit(event: SynapseChannelEvent): Promise<void> {
    await Promise.all([...this.#handlers].map((handler) => handler(event)));
  }
}

/** 模拟首次助手转录写入失败，用于验证发送成功后的转录修复 */
export class FailFirstAssistantTranscriptStore extends InMemoryTranscriptStore {
  #failed = false;

  override async append(input: TranscriptAppendInput) {
    if (input.role === "assistant" && !this.#failed) {
      this.#failed = true;
      throw new Error("transcript write failed");
    }

    return super.append(input);
  }
}

/** 记录转录写入输入，用于检查事件归属与上下文边界 */
export class RecordingTranscriptStore extends InMemoryTranscriptStore {
  readonly appends: TranscriptAppendInput[] = [];

  override async append(input: TranscriptAppendInput) {
    this.appends.push(input);
    return super.append(input);
  }
}

/** 记录规范事件接受输入，用于检查持久化之前的路由决策 */
export class RecordingConversationStore extends InMemoryConversationStore {
  readonly accepted: AcceptNormalizedEventInput[] = [];

  override async acceptNormalizedEvent(input: AcceptNormalizedEventInput) {
    this.accepted.push(input);
    return super.acceptNormalizedEvent(input);
  }
}

/** 模拟规范事件持久化失败，验证后续代理与发送被阻止 */
export class FailingConversationStore extends InMemoryConversationStore {
  override async acceptNormalizedEvent(): ReturnType<InMemoryConversationStore["acceptNormalizedEvent"]> {
    throw new Error("conversation persistence unavailable");
  }
}

/** 记录幂等状态的创建与更新，用于验证注入存储的使用 */
export class RecordingEventProcessStore extends InMemoryEventProcessStore {
  readonly begins: EventProcessBeginInput[] = [];
  readonly updates: Array<{ id: string; status: EventProcessState["status"] | undefined }> = [];

  override async begin(input: EventProcessBeginInput): Promise<EventProcessState> {
    this.begins.push(input);
    return super.begin(input);
  }

  override async update(
    id: string,
    patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>
  ): Promise<EventProcessState> {
    this.updates.push({ id, status: patch.status });
    return super.update(id, patch);
  }
}

/** 模拟幂等存储不可用，验证代理不会越过恢复边界执行 */
export class FailingEventProcessStore extends InMemoryEventProcessStore {
  override async begin(): Promise<EventProcessState> {
    throw new Error("idempotency unavailable");
  }
}

/** 模拟身份解析失败 */
export const failingIdentityResolver: IdentityResolver = {
  async resolve() {
    throw new Error("identity unavailable");
  }
};

/** 创建群聊文本事件，固定平台与时间以隔离场景变量 */
export function groupMessage(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "group-1", kind: "group" },
    sender: { id: "user-1" },
    message: textMessage(text),
    raw: {},
    receivedAt: new Date(0).toISOString()
  };
}

/** 创建保留原始片段顺序的群聊事件 */
export function groupMessageWithSegments(id: string, segments: readonly MessageSegment[]): SynapseChannelEvent {
  return {
    ...groupMessage(id, ""),
    message: {
      type: "mixed",
      segments
    }
  };
}

/** 创建带稳定消息标识的私聊事件 */
export function privateMessage(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "user-1", kind: "private" },
    sender: { id: "user-1" },
    message: textMessage(text, id),
    raw: {},
    receivedAt: new Date(0).toISOString()
  };
}

/** 提取发送消息中的文本，避免断言依赖非文本片段的实现细节 */
export function sentText(message: SynapseMessage | undefined): string {
  return (
    message?.segments
      .filter(
        (segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text"
      )
      .map((segment) => segment.text)
      .join("") ?? ""
  );
}

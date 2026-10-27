import type { ChannelAdapter, ChannelEventHandler, ChannelStatus } from "@synapse/runtime-channel";
import { createChannelCapabilityProfile } from "@synapse/runtime-channel";
import type {
  ChannelCapabilityProfile,
  ChannelActionTarget,
  GroupFileUpload,
  ChannelOperationResult,
  ChannelOutputAction,
  PlatformAction,
  SynapseChannelEvent,
  SynapseMessage
} from "@synapse/runtime-protocol";
import { OneBot11Api, ONEBOT11_MESSAGE_SEGMENT_TYPES } from "./api.js";
import { OneBot11HttpTransport } from "./http-transport.js";
import { NapCatApi } from "./napcat.js";
import { normalizeOneBot11Event } from "./normalize.js";
import type { OneBot11Connection } from "./transport.js";
import type { OneBot11ChannelAdapterOptions } from "./types.js";
import { isRecord } from "./utils.js";
import { OneBot11WebSocketTransport } from "./websocket-transport.js";

/** 组合 OneBot11 连接、标准 API 与显式启用的 NapCat 扩展 */
export class OneBot11ChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "onebot11";
  readonly provider: string;
  readonly #connection: OneBot11Connection;
  readonly #api: OneBot11Api;
  readonly #napcat: NapCatApi | undefined;
  readonly #handlers = new Set<ChannelEventHandler>();

  constructor(options: OneBot11ChannelAdapterOptions) {
    this.id = options.id;
    this.provider = options.provider ?? "napcat";
    this.#connection =
      options.transport === "http"
        ? new OneBot11HttpTransport(options)
        : new OneBot11WebSocketTransport(options, (payload) => this.handlePayload(payload));
    this.#api = new OneBot11Api(this.#connection);
    this.#napcat = this.provider === "napcat" ? new NapCatApi(this.#connection) : undefined;
  }

  /** 连接状态与请求关联由具体传输拥有 */
  connect(): Promise<void> {
    return this.#connection.connect();
  }

  /** 断开连接并结束进行中的传输等待，不推测平台执行结果 */
  disconnect(): Promise<void> {
    return this.#connection.disconnect();
  }

  /** 读取当前传输状态 */
  async getStatus(): Promise<ChannelStatus> {
    return this.#connection.getStatus();
  }

  /** 组合标准能力与扩展实现来源，不将 NapCat 文件接口声明为 OneBot11 原生能力 */
  getCapabilities(): ChannelCapabilityProfile {
    return createChannelCapabilityProfile({
      channelId: this.id,
      adapterType: this.type,
      capabilities: {
        "message.receive": { status: "supported", constraints: { targetTypes: ["private", "group"] } },
        "message.send": {
          status: "partially-supported",
          constraints: {
            targetTypes: ["private", "group"],
            messageComponents: [],
            replyContextKinds: ["message"],
            perTarget: { private: { mentionTargets: [] }, group: { mentionTargets: ["user", "all"] } },
            messageSegmentTypes: [
              ...ONEBOT11_MESSAGE_SEGMENT_TYPES,
              ...(this.#napcat === undefined ? [] : ["file" as const])
            ]
          }
        },
        "message.media": { status: "supported" },
        "message.delete": {
          status: "partially-supported",
          source: "documented",
          implementation: "onebot11:delete_msg",
          constraints: { targetTypes: ["private", "group"] },
          reason: "撤回权限和时限由平台决定"
        },
        "message.get": {
          status: "partially-supported",
          source: "documented",
          implementation: "onebot11:get_msg",
          constraints: { targetTypes: ["private", "group"] }
        },
        "file.upload": this.#napcat?.getFileCapability() ?? { status: "unsupported" }
      }
    });
  }

  /** 映射原生动作，未实现的原生能力仍可被协议表达，但不向平台伪发请求 */
  executeAction(action: Exclude<ChannelOutputAction, PlatformAction>): Promise<ChannelOperationResult> {
    switch (action.actionType) {
      case "message.send":
        return this.sendMessage(action.target, action.message);
      case "message.delete":
        return this.#api.deleteMessage(action.target, action.targetMessageId);
      case "message.get":
        return this.#api.getMessage(action.target, action.targetMessageId, this.id);
      case "file.upload":
        return (
          this.#napcat?.uploadFile(action.target, action.file) ??
          Promise.resolve({ status: "unsupported", error: "File upload requires NapCat." })
        );
      default:
        return Promise.resolve({
          status: "unsupported",
          error: "OneBot 11 adapter has no mapping for this native action."
        });
    }
  }

  /** 由扩展拥有附件交付编排，标准 API 不认识文件上传动作 */
  sendMessage(target: ChannelActionTarget, message: SynapseMessage): Promise<ChannelOperationResult> {
    return this.#napcat === undefined
      ? this.#api.sendMessage(target, message)
      : this.#napcat.sendMessage(target, message, this.#api);
  }

  /** 群文件仅通过 NapCat 扩展实现，调用方拥有权限、归属与交付幂等 */
  async uploadGroupFile(groupId: string, file: GroupFileUpload): Promise<ChannelOperationResult> {
    return this.#napcat === undefined
      ? { status: "unsupported", error: "当前 OneBot 提供方未声明群文件上传能力" }
      : this.#napcat.uploadGroupFile(groupId, file);
  }

  /** 注册规范事件处理器 */
  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  /** 将宿主或传输交付的平台事件归一化后分发 */
  async handlePayload(payload: unknown): Promise<readonly SynapseChannelEvent[]> {
    if (!isRecord(payload)) return [];
    const event = normalizeOneBot11Event(this.id, payload);
    if (event === undefined) return [];
    await Promise.all([...this.#handlers].map((handler) => handler(event)));
    return [event];
  }
}

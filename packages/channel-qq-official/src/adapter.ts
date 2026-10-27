import type { ChannelAdapter, ChannelEventHandler, ChannelStatus } from "@synapse/runtime-channel";
import { createChannelCapabilityProfile } from "@synapse/runtime-channel";
import type {
  ChannelCapabilityProfile,
  ChannelActionTarget,
  ChannelOperationResult,
  ChannelOutputAction,
  PlatformAction,
  SynapseChannelEvent,
  SynapseMessage
} from "@synapse/runtime-protocol";
import { QQ_OFFICIAL_API_BASE_URL } from "./constants.js";
import { normalizeQqOfficialDispatch } from "./normalize.js";
import { createQqOfficialSendBody, extractMessageId, renderTextMessage } from "./send-message.js";
import { QqOfficialAccessTokenClient } from "./token-client.js";
import type { FetchLike, QqOfficialChannelAdapterOptions, QqOfficialDispatchPayload, QqOfficialMode } from "./types.js";
import { defaultFetch, isRecord } from "./utils.js";

/** 将官方接口映射到原生动作，平台能力限制不裁剪原生协议 */
export class QqOfficialChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "qq-official";
  readonly provider = "qq-official";
  readonly #mode: QqOfficialMode;
  readonly #apiBaseUrl: string;
  readonly #tokenClient: QqOfficialAccessTokenClient;
  readonly #fetch: FetchLike;
  readonly #handlers = new Set<ChannelEventHandler>();
  #status: ChannelStatus = { state: "offline", checkedAt: new Date(0).toISOString() };

  constructor(options: QqOfficialChannelAdapterOptions) {
    this.id = options.id;
    this.#mode = options.mode ?? "webhook";
    this.#apiBaseUrl = options.apiBaseUrl ?? QQ_OFFICIAL_API_BASE_URL;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#tokenClient = new QqOfficialAccessTokenClient({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.tokenEndpoint === undefined ? {} : { tokenEndpoint: options.tokenEndpoint }),
      fetch: this.#fetch,
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  /** Webhook 仅表示本地接收准备完成，未实现的网关模式不能报告在线 */
  async connect(): Promise<void> {
    this.#status = { state: "connecting", checkedAt: new Date().toISOString() };
    if (this.#mode === "websocket") {
      this.#status = {
        state: "error",
        detail: "QQ official WebSocket gateway is not implemented.",
        checkedAt: new Date().toISOString()
      };
      throw new Error("QQ official WebSocket gateway is not implemented.");
    }
    this.#status = {
      state: "online",
      detail:
        "Local webhook adapter is ready; the host owns callback registration and authentication. Platform delivery is not verified by connect().",
      checkedAt: new Date().toISOString()
    };
  }

  /** 断开本地生命周期，不关闭 Runtime 或删除平台消息 */
  async disconnect(): Promise<void> {
    this.#status = { state: "offline", checkedAt: new Date().toISOString() };
  }

  /** 读取本地 adapter 状态，不冒充账号权限或平台投递探测 */
  async getStatus(): Promise<ChannelStatus> {
    return this.#status;
  }

  /** 声明实际映射的官方能力，文档存在但未实现的接口仍显式不支持 */
  getCapabilities(): ChannelCapabilityProfile {
    return createChannelCapabilityProfile({
      channelId: this.id,
      adapterType: this.type,
      capabilities: {
        "message.receive": {
          status: this.#mode === "webhook" ? "partially-supported" : "unsupported",
          source: "documented",
          constraints: { targetTypes: ["private", "group", "channel"] },
          reason: "接收由宿主 Webhook 交付；群全量事件依赖平台资格，WebSocket 网关尚未实现"
        },
        "message.send": {
          status: "partially-supported",
          source: "documented",
          constraints: {
            targetTypes: ["private", "group", "channel"],
            messageSegmentTypes: ["text", "mention", "reply", "reference", "rich-content"],
            richContentFormats: ["markdown"],
            messageComponents: [],
            perTarget: {
              private: { messageSegmentTypes: ["text", "reply", "reference", "rich-content"] },
              group: { messageSegmentTypes: ["text", "reply", "reference", "rich-content"] },
              channel: { mentionTargets: ["user"] }
            }
          }
        },
        "message.media": { status: "unsupported" },
        "message.delete": {
          status: "partially-supported",
          source: "documented",
          constraints: {
            targetTypes: ["private", "group", "channel"],
            perTarget: {
              private: { maxDeleteAgeSeconds: 120, ownMessagesOnly: true },
              group: { maxDeleteAgeSeconds: 120 }
            }
          },
          reason: "私聊限自己消息；群撤回权限取决于角色；频道撤回依赖私域资格"
        },
        "file.upload": { status: "unsupported" }
      }
    });
  }

  /** 原生动作统一分发，平台尚无映射时保留原生动作并明确拒绝 */
  executeAction(action: Exclude<ChannelOutputAction, PlatformAction>): Promise<ChannelOperationResult> {
    if (action.actionType === "message.send") return this.sendMessage(action.target, action.message);
    if (action.actionType === "message.delete") return this.deleteMessage(action.target, action.targetMessageId);
    return Promise.resolve({
      status: "unsupported",
      error: "QQ official adapter has no mapping for this native action."
    });
  }

  /** 请求发出后的传输异常保留未知回执，发送前校验和令牌失败属于明确失败 */
  async sendMessage(target: ChannelActionTarget, message: SynapseMessage): Promise<ChannelOperationResult> {
    let submitted = false;
    try {
      const markdown = message.segments.find((part) => part.type === "rich-content");
      const content =
        markdown === undefined
          ? renderTextMessage({
              ...message,
              segments: message.segments.map((part) =>
                part.type === "mention" && part.userId !== undefined
                  ? { type: "text", text: `<@${part.userId}>` }
                  : part
              )
            })
          : "";
      if (!isSupportedMessage(target, message))
        return {
          status: "unsupported",
          error: "QQ official adapter cannot encode this native message without losing content."
        };
      const accessToken = await this.#tokenClient.getAccessToken();
      const url = this.#sendMessageUrl(target);
      const body = createQqOfficialSendBody(target, message, content);
      submitted = true;
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          authorization: `QQBot ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        if (!response.ok)
          return {
            status: "failed",
            error: `QQ official send failed with HTTP ${response.status}.`,
            platformReceipt: { httpStatus: response.status }
          };
        throw new Error("Message response body could not be read.");
      }

      const code = responseCode(responseBody);
      if (!response.ok || (code !== undefined && code !== 0 && code !== "0")) {
        return {
          status: "failed",
          error: `QQ official send failed with HTTP ${response.status}.`,
          platformReceipt: { httpStatus: response.status, ...(code === undefined ? {} : { code }) }
        };
      }

      const messageId = extractMessageId(responseBody);
      if (messageId === undefined)
        return {
          status: "uncertain",
          error: "QQ official send did not return a message identifier; verify delivery before retrying."
        };
      return {
        status: "succeeded",
        ...(messageId === undefined ? {} : { messageId })
      };
    } catch (error) {
      return {
        status: submitted ? "uncertain" : "failed",
        error: submitted
          ? "QQ official message receipt was not confirmed; verify delivery before retrying."
          : error instanceof Error
            ? error.message
            : String(error)
      };
    }
  }

  /** 官方撤回成功允许空响应体，不能无条件调用 json 把已成功的撤回误报为未知 */
  async deleteMessage(target: ChannelActionTarget, messageId: string): Promise<ChannelOperationResult> {
    if (!messageId) return { status: "failed", error: "Message identifier is required." };
    let submitted = false;
    try {
      const accessToken = await this.#tokenClient.getAccessToken();
      submitted = true;
      const response = await this.#fetch(`${this.#sendMessageUrl(target)}/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
        headers: { authorization: `QQBot ${accessToken}` }
      });
      if (response.ok) {
        let body: unknown;
        if (response.text !== undefined) {
          const text = await response.text();
          body = text.trim().length === 0 ? undefined : JSON.parse(text);
        } else {
          try {
            body = await response.json();
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
        const code = responseCode(body);
        if (code !== undefined && code !== 0 && code !== "0")
          return {
            status: "failed",
            error: "QQ official rejected message deletion.",
            platformReceipt: { httpStatus: response.status, code }
          };
        return { status: "succeeded", messageId };
      }
      let code: string | number | undefined;
      try {
        code = responseCode(await response.json());
      } catch {
        /* 明确的 HTTP 拒绝不因诊断正文读取失败而变成未知结果 */
      }
      return {
        status: "failed",
        error: "QQ official rejected message deletion.",
        platformReceipt: { httpStatus: response.status, ...(code === undefined ? {} : { code }) }
      };
    } catch {
      return { status: submitted ? "uncertain" : "failed", error: "QQ official message deletion was not confirmed." };
    }
  }

  /** 注册原生事件订阅，权限校验由宿主负责 */
  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  /** 将宿主验证过的官方事件转换为原生事件后分发 */
  async handlePayload(payload: QqOfficialDispatchPayload): Promise<readonly SynapseChannelEvent[]> {
    const event = normalizeQqOfficialDispatch(this.id, payload);

    if (event === undefined) {
      return [];
    }

    await Promise.all([...this.#handlers].map((handler) => handler(event)));
    return [event];
  }

  #sendMessageUrl(target: ChannelActionTarget): string {
    const baseUrl = this.#apiBaseUrl.replace(/\/$/, "");

    if (target.type === "private") {
      return `${baseUrl}/v2/users/${encodeURIComponent(target.userId)}/messages`;
    }

    if (target.type === "group") {
      return `${baseUrl}/v2/groups/${encodeURIComponent(target.groupId)}/messages`;
    }

    return `${baseUrl}/channels/${encodeURIComponent(target.channelId)}/messages`;
  }
}

function responseCode(body: unknown): string | number | undefined {
  return isRecord(body) && (typeof body.code === "string" || typeof body.code === "number") ? body.code : undefined;
}

function isSupportedMessage(target: ChannelActionTarget, message: SynapseMessage): boolean {
  if (message.components?.length) return false;
  const replies = message.segments.filter((part) => part.type === "reply");
  const references = message.segments.filter((part) => part.type === "reference");
  if (replies.length > 1 || references.length > 1) return false;
  const sequence = message.replyTo?.sequence ?? replies[0]?.sequence;
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) return false;
  const markdown = message.segments.filter((part) => part.type === "rich-content");
  if (markdown.length > 1) return false;
  return message.segments.every((part) => {
    switch (part.type) {
      case "text":
        return markdown.length === 0;
      case "reply":
        return part.messageId !== undefined || part.eventId !== undefined;
      case "reference":
        return part.messageId !== undefined;
      case "mention":
        return markdown.length === 0 && target.type === "channel" && part.target !== "all" && part.userId !== undefined;
      case "rich-content":
        return part.format === "markdown" && typeof part.value === "string" && part.value.length > 0;
      default:
        return false;
    }
  });
}

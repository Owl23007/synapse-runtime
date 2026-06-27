import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEventHandler,
  ChannelStatus,
  ChannelTarget,
  SendResult
} from "@synapse/runtime-channel";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import { QQ_OFFICIAL_API_BASE_URL } from "./constants.js";
import { normalizeQqOfficialDispatch } from "./normalize.js";
import {
  createQqOfficialSendBody,
  extractMessageId,
  renderTextMessage
} from "./send-message.js";
import { QqOfficialAccessTokenClient } from "./token-client.js";
import type { FetchLike, QqOfficialChannelAdapterOptions, QqOfficialDispatchPayload, QqOfficialMode } from "./types.js";
import { defaultFetch, safeJson } from "./utils.js";

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

  async connect(): Promise<void> {
    this.#status = { state: "connecting", checkedAt: new Date().toISOString() };
    this.#status = {
      state: "online",
      detail:
        this.#mode === "webhook"
          ? "Webhook mode is ready; access token will be requested lazily before sending."
          : "Gateway loop is not started by this adapter yet; access token will be requested lazily before sending.",
      checkedAt: new Date().toISOString()
    };
  }

  async disconnect(): Promise<void> {
    this.#status = { state: "offline", checkedAt: new Date().toISOString() };
  }

  async getStatus(): Promise<ChannelStatus> {
    return this.#status;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      receivePrivateMessage: true,
      receiveGroupMessage: true,
      receiveAllGroupMessages: false,
      requiresMention: true,
      sendPrivateMessage: true,
      sendGroupMessage: true,
      sendMedia: false,
      manageGroup: false,
      recallMessage: false,
      complianceLevel: "official",
      riskLevel: "low"
    };
  }

  async sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult> {
    const content = renderTextMessage(message);
    const accessToken = await this.#tokenClient.getAccessToken();
    const url = this.#sendMessageUrl(target);
    const body = createQqOfficialSendBody(target, message, content);
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const responseBody = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: `QQ official send failed with HTTP ${response.status}: ${safeJson(responseBody)}`
      };
    }

    const messageId = extractMessageId(responseBody);

    return {
      ok: true,
      ...(messageId === undefined ? {} : { messageId })
    };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async handlePayload(payload: QqOfficialDispatchPayload): Promise<readonly SynapseChannelEvent[]> {
    const event = normalizeQqOfficialDispatch(this.id, payload);

    if (event === undefined) {
      return [];
    }

    await Promise.all([...this.#handlers].map((handler) => handler(event)));
    return [event];
  }

  #sendMessageUrl(target: ChannelTarget): string {
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

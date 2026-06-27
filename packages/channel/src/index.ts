import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";

export type ChannelStatusState = "offline" | "connecting" | "online" | "error";

export interface ChannelStatus {
  readonly state: ChannelStatusState;
  readonly detail?: string;
  readonly checkedAt: string;
}

export interface ChannelCapabilities {
  readonly receivePrivateMessage: boolean;
  readonly receiveGroupMessage: boolean;
  readonly receiveAllGroupMessages: boolean;
  readonly requiresMention: boolean;
  readonly sendPrivateMessage: boolean;
  readonly sendGroupMessage: boolean;
  readonly sendMedia: boolean;
  readonly manageGroup: boolean;
  readonly recallMessage: boolean;
  readonly complianceLevel: "official" | "community" | "unofficial";
  readonly riskLevel: "low" | "medium" | "high";
}

export type ChannelTarget =
  | { readonly type: "private"; readonly userId: string }
  | { readonly type: "group"; readonly groupId: string }
  | { readonly type: "channel"; readonly channelId: string };

export interface SendResult {
  readonly ok: boolean;
  readonly messageId?: string;
  readonly error?: string;
}

export type ChannelEventHandler = (event: SynapseChannelEvent) => void | Promise<void>;

export interface ChannelAdapter {
  readonly id: string;
  readonly type: string;
  readonly provider: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<ChannelStatus>;
  getCapabilities(): ChannelCapabilities;
  sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult>;
  onEvent(handler: ChannelEventHandler): void;
}

export interface ChannelRegistry {
  register(adapter: ChannelAdapter): void;
  get(channelId: string): ChannelAdapter | undefined;
  list(): readonly ChannelAdapter[];
}

export class InMemoryChannelRegistry implements ChannelRegistry {
  readonly #adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Channel adapter "${adapter.id}" is already registered.`);
    }

    this.#adapters.set(adapter.id, adapter);
  }

  get(channelId: string): ChannelAdapter | undefined {
    return this.#adapters.get(channelId);
  }

  list(): readonly ChannelAdapter[] {
    return [...this.#adapters.values()];
  }
}

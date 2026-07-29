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
  /** 建立频道连接 */
  connect(): Promise<void>;
  /** 断开频道连接 */
  disconnect(): Promise<void>;
  /** 读取频道连接状态 */
  getStatus(): Promise<ChannelStatus>;
  /** 读取频道能力声明 */
  getCapabilities(): ChannelCapabilities;
  /** 向频道目标发送消息 */
  sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult>;
  /** 注册频道事件处理器 */
  onEvent(handler: ChannelEventHandler): void;
}

export interface ChannelRegistry {
  /** 注册频道适配器 */
  register(adapter: ChannelAdapter): void;
  /** 注销并返回频道适配器 */
  unregister(channelId: string): ChannelAdapter | undefined;
  /** 按频道标识读取适配器 */
  get(channelId: string): ChannelAdapter | undefined;
  /** 列出全部频道适配器 */
  list(): readonly ChannelAdapter[];
}

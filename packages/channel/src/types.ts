import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";

export type ChannelStatusState = "offline" | "connecting" | "online" | "error";

export interface ChannelStatus {
  readonly state: ChannelStatusState;
  readonly detail?: string;
  readonly checkedAt: string;
}

/** 适配器已经实现的能力，未声明的可选能力视为不支持 */
export interface ChannelCapabilities {
  readonly receivePrivateMessage: boolean;
  readonly receiveGroupMessage: boolean;
  readonly receiveAllGroupMessages: boolean;
  readonly requiresMention: boolean;
  readonly sendPrivateMessage: boolean;
  readonly sendGroupMessage: boolean;
  readonly sendMedia: boolean;
  /** 支持把内容直接上传为群文件，不能用发送链接代替 */
  readonly uploadGroupFile?: boolean;
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

/** 向群文件接口提交的已校验内容，不接受宿主路径 */
export interface GroupFileUpload {
  readonly name: string;
  readonly data: Uint8Array;
}

/** 群文件上传终态，连接丢失或超时必须保留结果不确定语义 */
export type GroupFileUploadResult =
  | { readonly status: "succeeded"; readonly fileId?: string }
  | { readonly status: "failed" | "unsupported" | "uncertain"; readonly error: string };

/** 频道收发与生命周期契约，扩展动作通过可选能力保持兼容 */
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
  /** 上传群文件并返回实际平台回执，调用方负责权限、归属和幂等控制 */
  uploadGroupFile?(groupId: string, file: GroupFileUpload): Promise<GroupFileUploadResult>;
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

import type {
  ChannelCapabilityProfile,
  ChannelActionTarget,
  GroupFileUpload,
  ChannelOperationResult,
  PlatformAction,
  SynapseChannelEvent,
  SynapseMessage
} from "@synapse/runtime-protocol";

/** 频道连接状态，不代表具体平台动作的执行结果 */
export type ChannelStatusState = "offline" | "connecting" | "online" | "error";

/** 频道连接状态及最近检查时间 */
export interface ChannelStatus {
  readonly state: ChannelStatusState;
  readonly detail?: string;
  readonly checkedAt: string;
}

/** 接收已归一化事件的处理器 */
export type ChannelEventHandler = (event: SynapseChannelEvent) => void | Promise<void>;

/** 频道收发与生命周期契约，平台操作使用 protocol 的统一回执 */
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
  getCapabilities(): ChannelCapabilityProfile;
  /** 向频道目标发送消息 */
  sendMessage(target: ChannelActionTarget, message: SynapseMessage): Promise<ChannelOperationResult>;
  /** 上传群文件并返回实际平台回执，调用方负责权限、归属和幂等控制 */
  uploadGroupFile?(groupId: string, file: GroupFileUpload): Promise<ChannelOperationResult>;
  /** 执行已声明的平台扩展，标准动作不能通过扩展绕过能力约束 */
  executePlatformAction?(action: PlatformAction): Promise<ChannelOperationResult>;
  /** 注册频道事件处理器 */
  onEvent(handler: ChannelEventHandler): void;
}

/** 按频道标识管理 Adapter 实例 */
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

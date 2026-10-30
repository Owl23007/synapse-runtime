/** 文件发现是独立事实，不应伪装成可触发对话的消息 */
export interface ChannelFileNotice {
  readonly channelId: string;
  readonly platform: string;
  readonly provider: string;
  readonly conversation: { readonly kind: "group" | "private"; readonly id: string };
  readonly file: { readonly fileId: string; readonly name: string; readonly size?: number; readonly busid?: string };
  readonly senderId?: string;
  readonly observedAt: string;
  readonly sourceEventId?: string;
}

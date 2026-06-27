export type Platform = "qq" | "telegram" | "discord" | "webhook" | "cli" | "mobile";
export type ConversationKind = "private" | "group" | "channel" | "system";
export interface ConversationRef {
    readonly id: string;
    readonly kind: ConversationKind;
    readonly title?: string;
}
export interface SenderRef {
    readonly id: string;
    readonly displayName?: string;
    readonly roles?: readonly string[];
}
export type MessageType = "text" | "image" | "file" | "audio" | "video" | "mixed";
export type MessageSegment = {
    readonly type: "text";
    readonly text: string;
} | {
    readonly type: "image";
    readonly url?: string;
    readonly fileId?: string;
    readonly localPath?: string;
    readonly alt?: string;
} | {
    readonly type: "file";
    readonly name: string;
    readonly url?: string;
    readonly fileId?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
} | {
    readonly type: "audio";
    readonly url?: string;
    readonly fileId?: string;
    readonly durationMs?: number;
} | {
    readonly type: "video";
    readonly url?: string;
    readonly fileId?: string;
    readonly durationMs?: number;
};
export interface SynapseMessage {
    readonly id?: string;
    readonly type: MessageType;
    readonly segments: readonly MessageSegment[];
    readonly raw?: unknown;
}
export type ChannelEventType = "message.created" | "message.deleted" | "member.joined" | "member.left" | "notice";
export interface SynapseChannelEvent {
    readonly id: string;
    readonly platform: Platform;
    readonly channelId: string;
    readonly eventType: ChannelEventType;
    readonly conversation: ConversationRef;
    readonly sender: SenderRef;
    readonly message?: SynapseMessage;
    readonly raw?: unknown;
    readonly receivedAt: string;
}
export declare function textMessage(text: string, id?: string): SynapseMessage;
export declare function getTextContent(message: SynapseMessage): string;
//# sourceMappingURL=index.d.ts.map
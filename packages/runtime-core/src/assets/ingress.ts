import type { ChannelFileNotice } from "@synapse/runtime-protocol";
import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { IdentityStore } from "../context/identity.js";
import type { WorkspaceStore } from "../context/workspace.js";
import type { AssetIndex } from "./types.js";

/** 文件入口复用身份与工作区解析，不创建会话、转录或运行 */
export class ResourceIngress {
  /** 应用层注入与对话相同的持久化端口 */
  constructor(
    readonly assets: AssetIndex,
    readonly workspaces: WorkspaceStore,
    readonly identities: IdentityStore
  ) {}

  /** 稳定来源键只包含平台定位事实，不包含名称或过期 URL */
  async receive(notice: ChannelFileNotice) {
    const sender = notice.senderId ?? notice.conversation.id;
    const resolved = await this.identities.resolveIdentity({
      identityId: `guest:${notice.platform}:${notice.provider}:${notice.channelId}:${sender}`,
      platform: notice.platform,
      provider: notice.provider,
      channelId: notice.channelId,
      platformUserId: sender,
      type: "guest",
      roles: [],
      isBound: false
    });
    const workspace = await this.workspaces.resolveWorkspace({
      platform: notice.platform,
      provider: notice.provider,
      channelId: notice.channelId,
      conversationType: notice.conversation.kind,
      conversationId: notice.conversation.id,
      identityId: resolved.identity.id,
      defaultWorkspace:
        notice.conversation.kind === "group"
          ? {
              id: `group:${notice.platform}:${notice.channelId}:${notice.conversation.id}`,
              type: "group",
              name: notice.conversation.id
            }
          : { id: `personal:${resolved.identity.id}`, type: "personal", name: sender }
    });
    const asset = this.assets.observe({
      workspaceId: workspace.id,
      name: notice.file.name,
      kind: notice.conversation.kind === "group" ? "qq_group" : "qq_private",
      observedAt: notice.observedAt,
      ...(notice.file.size === undefined ? {} : { size: notice.file.size }),
      locator: {
        platform: notice.platform,
        provider: notice.provider,
        channelId: notice.channelId,
        conversationId: notice.conversation.id,
        fileId: notice.file.fileId,
        ...(notice.file.busid ? { busid: notice.file.busid } : {})
      }
    });
    if (notice.sourceEventId)
      this.assets.reference({
        workspaceId: workspace.id,
        assetId: asset.id,
        versionId: null,
        refType: "message",
        refId: `${notice.channelId}:${notice.conversation.id}:${notice.sourceEventId}`
      });
    return asset;
  }

  /** 消息附件在触发判断之外索引，只保留文件事实而不保存消息全文 */
  async receiveMessage(event: SynapseChannelEvent, provider: string): Promise<void> {
    if (event.origin === "outgoing" || !["group", "private"].includes(event.conversation.kind)) return;
    for (const part of event.message?.segments ?? []) {
      if (part.type !== "file" || !part.fileId) continue;
      await this.receive({
        channelId: event.channelId,
        platform: event.platform,
        provider,
        conversation: { kind: event.conversation.kind as "group" | "private", id: event.conversation.id },
        file: { fileId: part.fileId, name: part.name },
        senderId: event.sender.id,
        observedAt: event.receivedAt,
        sourceEventId: event.message?.id ?? event.externalEventId ?? event.id
      });
    }
  }
}

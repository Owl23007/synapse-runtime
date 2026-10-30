export { CHANNEL_PROTOCOL_SCHEMA_VERSION } from "./types.js";
export type { ChannelFileNotice } from "./file-notice.js";
export type {
  AdapterCapabilities,
  ChannelCapabilityConstraints,
  ChannelCapabilityKey,
  ChannelActionStatus,
  GroupFileUpload,
  ChannelFileUpload,
  GroupFileUploadAction,
  PlatformAction,
  ChannelOperationResult,
  CapabilityStatus,
  ChannelActionResult,
  ChannelActionTarget,
  ChannelActionType,
  ChannelCapability,
  ChannelCapabilityProfile,
  ChannelEventType,
  ChannelOutputAction,
  ChannelOutputActionBase,
  ChannelTriggerHint,
  ChannelProtocolSchemaVersion,
  ConversationKind,
  ConversationRef,
  MessageDeleteAction,
  MessageEditAction,
  MessageSendAction,
  MessageReplyRef,
  MessageSegment,
  MessageType,
  MessageComponent,
  ChannelEventResource,
  ReactionRef,
  FileUploadAction,
  Platform,
  ProtocolPartMetadata,
  ReactionAction,
  SenderRef,
  SynapseChannelEvent,
  SynapseMessage,
  UnknownMessagePart
} from "./types.js";
export { CHANNEL_NATIVE_ACTIONS, CHANNEL_NATIVE_MESSAGE_SEGMENTS } from "./channel-capabilities.js";
export type {
  ChannelResourceActionType,
  ChannelPageRequest,
  ChannelPage,
  ChannelMessageRecord,
  ChannelFileRef,
  ChannelMember,
  ChannelResourceActionBase,
  ChannelMessageResourceAction,
  ChannelFileResourceAction,
  ChannelConversationAction,
  ChannelMemberAction,
  ChannelInteractionAction,
  ChannelTypingAction,
  ChannelResourceAction,
  ChannelResourceResult
} from "./channel-resources.js";
export { getTextContent, textMessage } from "./message.js";
export { readToolOutput, type ToolOutput } from "./tool-output.js";
export { channelAction, messageSendAction, groupFileUploadAction, type ChannelActionInput } from "./actions.js";

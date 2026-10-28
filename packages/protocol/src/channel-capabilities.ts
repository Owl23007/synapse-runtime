import type { ChannelActionType, MessageSegment } from "./types.js";

/** 原生动作全集，表示协议能够表达的能力，不表示任何 adapter 已实现或获得授权 */
export const CHANNEL_NATIVE_ACTIONS = {
  "message.send": "发送消息",
  "message.edit": "编辑消息",
  "message.delete": "删除消息",
  "message.get": "读取消息",
  "message.list": "查询消息历史",
  "message.forward": "转发消息",
  "message.pin": "置顶消息",
  "message.unpin": "取消置顶",
  "message.read": "标记已读",
  "message.stream": "流式更新消息",
  "reaction.add": "添加表情回应",
  "reaction.remove": "移除表情回应",
  "file.upload": "上传文件",
  "file.get": "读取文件引用",
  "file.list": "列出文件",
  "file.delete": "删除文件",
  "conversation.get": "读取会话",
  "conversation.list": "列出会话",
  "conversation.create": "创建会话",
  "conversation.update": "更新会话",
  "conversation.leave": "离开会话",
  "member.get": "读取成员",
  "member.list": "列出成员",
  "member.update": "更新成员",
  "member.remove": "移除成员",
  "interaction.respond": "响应交互",
  "typing.set": "设置输入状态",
  "platform.execute": "执行显式平台扩展"
} as const satisfies Readonly<Record<ChannelActionType, string>>;

/** 原生片段全集，保留富内容与未知片段，外部平台限制不能删减原生内容模型 */
export const CHANNEL_NATIVE_MESSAGE_SEGMENTS = {
  text: true,
  mention: true,
  reply: true,
  image: true,
  file: true,
  audio: true,
  video: true,
  emoji: true,
  sticker: true,
  reference: true,
  "rich-content": true,
  unknown: true
} as const satisfies Readonly<Record<MessageSegment["type"], true>>;

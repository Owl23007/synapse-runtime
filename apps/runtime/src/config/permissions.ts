/** 默认权限表，未配置 permissions 时整体采用此表 */
export const DEFAULT_PERMISSIONS = {
  "channel.qq.send_group_message": "allow",
  "channel.qq.send_channel_message": "allow",
  "channel.qq.send_private_message": "deny",
  "channel.qq.manage_group": "deny",
  "channel.qq.send_media": "deny",
  "network.web.search": "allow",
  "network.web.fetch": "allow"
} as const;

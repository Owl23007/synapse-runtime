# Adapter Capability Matrix

## OneBot11 / NapCat

| Capability          | Runtime behavior                                                                    |
| ------------------- | ----------------------------------------------------------------------------------- |
| Bot identity        | Uses `event.self_id` as `triggerHint.selfUserId` when present.                      |
| Mention user        | `[CQ:at,qq=123]` becomes `mention target=user userId=123`.                          |
| Mention all         | `[CQ:at,qq=all]` becomes `mention target=all` and does not trigger by default.      |
| Unknown mention     | Malformed `at` becomes `mention target=unknown` and does not trigger by default.    |
| Reply target        | `[CQ:reply,id=...]` becomes `message.replyTo.messageId`.                            |
| Reply to bot        | Enabled. Runtime matches `replyTo.messageId` against assistant `externalMessageId`. |
| Outgoing message id | `send_msg` response `message_id` is stored as assistant `externalMessageId`.        |
| Group management    | Not advertised until management operations exist on the adapter contract.           |
| Message recall      | Not advertised until recall exists on the adapter contract.                         |

NapCat 提供 `uploadGroupFile` 能力：通过 `upload_group_file` 上传 base64 文件内容，返回平台文件 ID（存在时）。其他 OneBot 提供方与 QQ Official 未声明此能力，不会自动回退为链接或普通文本。网络超时标记为 `uncertain`，不自动重试。

协议依据：[NapCat 群文件动作](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/UploadGroupFile.ts)与[文件 URI 解析](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-common/src/file.ts)。0.1 限制单个群文件不超过 10 MiB，并拒绝空文件。

## QQ Official Group

| Event                     | Runtime behavior                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GROUP_AT_MESSAGE_CREATE` | Sets `platformMentionedBot=true`; triggers as `platform_at_event` even without mention segments.                                    |
| `GROUP_MESSAGE_CREATE`    | Does not automatically mean @bot. It can trigger by configured keyword, command, or a mention that matches configured `botUserIds`. |
| Reply target              | `reply_to_bot` is conditional and only enabled when payload contains an explicit reply target id.                                   |
| Passive reply window      | Modeled separately from context TTL as `300` seconds; expired replies omit passive reply identifiers.                               |

## QQ Official Channel / Guild

| Event               | Runtime behavior                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AT_MESSAGE_CREATE` | Modeled as `conversation.kind=channel` and sets `platformMentionedBot=true`.                                       |
| `MESSAGE_CREATE`    | Does not automatically trigger.                                                                                    |
| Reply target        | `message_reference` / equivalent reply target can trigger `reply_to_bot`; reply has priority over platform @ hint. |

## QQ Official C2C / DM

| Event                                          | Runtime behavior                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `C2C_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE` | Modeled as `conversation.kind=private`.                                                                |
| History policy                                 | Reuses private TTL and maxMessages.                                                                    |
| Passive reply window                           | Modeled separately from context TTL as `3600` seconds; expired replies omit passive reply identifiers. |

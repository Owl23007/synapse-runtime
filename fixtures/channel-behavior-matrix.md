# 当前版本 Channel 行为实测

2026-10-27 对照文档验证，范围为 NapCat 4.18.19（远端 Node.js 24.18.0）与当前仓库 Runtime CLI/TUI（本地 Node.js 24.21.0）。共保留 35 个真实采集样例和原有 6 个文档种子。每个样例记录实际运行的部署提交、采集时间和限制；QQ 官方通道的 3 个样例仍为 `documented`，本轮未使用其服务。

文档依据：[NapCat 4.18.19 API](https://napneko.github.io/api/4.18.19)、[OneBot11 公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)、[NapCat 网络与 echo](https://napneko.github.io/onebot/network)，以及本仓库 [README](../README.md)、Runtime CLI `--help` 和 TUI 控制器支持的命令。文档期望、平台实测与统一契约建议分开记录，以下建议尚未自动改变适配器实现。

## NapCat

| 行为              | 文档/调用预期                                           | 当前版本观测                                                                         | 对 channel 的约束                                                                          | 证据                                                                        |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 版本与状态        | `get_version_info` / `get_status`                       | `4.18.19`；`online=true`、`good=true`                                                | 连接成功与账号在线分别表达，能力证据绑定部署版本                                           | `get-version-info`、`get-status`                                            |
| 私聊/群聊文本发送 | `send_msg` 接受目标、消息并返回 message_id              | 数字字符串目标、CQ 字符串、`auto_escape=false` 均成功；响应含 `stream=normal-action` | 保留平台消息标识，允许未知响应字段；回执成功不等于客户端已显示或用户已读                   | `send-private-text`、`send-group-text`                                      |
| 消息查询与转义    | `get_msg` 用发送回执中的标识查询                        | 数组片段保存原始文本；raw_message 将 `&` 和方括号转义；自发消息为 `message_sent`     | 以片段为规范内容，不能再次解码造成失真；自发消息与用户输入保留来源差异                     | `get-private-message`、`get-group-message`                                  |
| 引用与 @          | CQ reply 使用已有 message_id；CQ at 使用账号            | 私聊/群聊引用及群 @ 返回成功                                                         | reply 与 mention 分别建模；渲染和通知仍需客户端确认                                        | `send-private-reply`、`send-group-reply`、`send-group-mention`              |
| 图片              | CQ image 可携带 base64 资源                             | 初始资源被拒绝（1200）；校验过的 16×16 PNG 成功，随后撤回成功                        | 单个资源失败不能升级为整个图片能力不支持；保留失败码与资源限制                             | `send-group-image-initial-resource`、`send-group-image`、`recall-message-1` |
| 私聊/群聊文件     | NapCat 扩展 `upload_private_file` / `upload_group_file` | 小型 UTF-8 文本通过 base64 内容上传，`upload_file=true`，响应含 file_id              | 文件接口属于 NapCat 扩展；远端不能假设可读本地路径；本轮不验证大小上限                     | `upload-private-file`、`upload-group-file`                                  |
| 撤回              | `delete_msg` 使用 message_id                            | 7 条早先测试记录撤回成功；另 1 条群记录失败（1200）；复核图片撤回成功                | 删除能力需要目标、时限和失败语义，不能笼统声明所有内容均可撤回；消息撤回与文件清理分别验证 | `recall-private-*`、`recall-group-*`、`recall-message-1`                    |
| 未知动作          | 返回可关联的错误                                        | `status=failed`、`retcode=1404`，echo 原样关联                                       | 显式平台拒绝属于 failed；传输超时属于结果未知，不能自动重发                                | `unknown-action`                                                            |
| 用户输入          | 私聊消息含 sender、message_id、数组片段                 | 测试账号主动发送的标记文本可从历史中查到，`post_type=message`                        | 入站消息与历史恢复共用内容模型，但来源、实时性和去重语义需保留                             | `history-private-input-1`                                                   |

本轮监听窗口没有捕获带标记的实时推送；历史消息快照不作为推送证据。群入站、推送时序、重连补偿、重复事件、文件最终展示、客户端引用/@ 显示和大文件边界仍未验证。群文件列表查询成功，但未找到该名称的根目录文件，因此没有执行删除文件动作；不能据此断言所有文件副本已清除。撤回失败记录保留为事实，不声称所有测试内容均已消失。

## Runtime CLI / TUI

| 行为              | 文档/调用预期                     | 当前版本观测                                                         | 对 channel 的约束                                                       | 证据                                       |
| ----------------- | --------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| status / channels | 管理命令输出 JSON                 | 独立 CLI 子进程调用真实服务，stdout 为单个 JSON，stderr 为空，退出 0 | JSON 结果、诊断文本与退出码分别定义；管理接口不是聊天接口               | `status`、`channels`                       |
| 鉴权失败          | Admin API 拒绝无效令牌            | stderr 含 HTTP 401，stdout 为空，退出 1                              | 不将失败包装成成功消息；不输出令牌                                      | `unauthorized`                             |
| 未知选项          | 参数解析拒绝                      | 明确 `Unknown argument`，退出 1                                      | 定义稳定的无效输入错误                                                  | `unknown-argument`                         |
| 未知位置参数      | 文档未声明 chat                   | `chat fixture text` 回落默认 start，在隔离目录报配置文件缺失，退出 1 | 这是待规范行为，不能解释为标准 unsupported 回执；未来宜统一命令拒绝语义 | `unknown-command`（tested-partial）        |
| TUI 管理命令      | `/status`、`/channels`、`/config` | 真实 Admin API 连接下进入对应视图，返回 continue                     | 命令输入与消息输入应有明确分界；视图状态不能充当 channel 消息           | `tui-status`、`tui-channels`、`tui-config` |
| TUI 普通文本      | 当前控制台只声明管理命令          | 普通文本反馈 Unknown command，没有聊天提交                           | 当前没有独立 CLI channel 收发契约，不能从管理命令测试宣称已支持聊天     | `tui-plain-text`                           |
| 附着模式退出      | 客户端独立于服务                  | `/quit` 返回 exit，TUI stopped，真实服务健康接口仍为 200             | 客户端 disconnect 与 Runtime shutdown 分别定义                          | `tui-attached-quit`                        |

TUI 使用真实控制器和真实服务验证命令行为，未覆盖 Ink 渲染、键盘、伪终端和窗口尺寸。已有 `tools/runtime-tui.test.mjs` 继续验证 TUI 自建 Runtime 的生命周期；本轮新增记录不替代既有集成测试。

## 据此需要规范的公共行为

1. 规范消息包含目标类型、发送者、外部消息标识、有序片段和来源；保留 `message` / `message_sent` 及历史查询来源，避免机器人自回复循环
2. 操作结果区分明确成功、明确拒绝、不支持与结果未知；保留平台码和可关联回执；超时不自动重试有副作用的发送
3. 能力按目标、片段、扩展提供方和实际版本描述；成功上传小文件不代表任意大小、格式或目标均可用
4. 发送、文件上传、消息撤回、文件删除和客户端断开分别建模；复合交付存在部分成功，不能当作原子操作
5. CLI/TUI 管理命令与对话入口分开约定；终端入口需明确 stdout/stderr、退出码、未知输入、会话和生命周期语义
6. `documented`、实测支持、实测偏差、环境阻塞与未验证不能混用；真实平台样本离线回放只验证适配兼容，不能替代下次升级后的真实服务复测

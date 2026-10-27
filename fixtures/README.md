# Channel protocol fixtures

These fixtures are versioned contract-test assets for Channel adapters. They
belong in Git because tests and protocol validation depend on them; they are not
documentation-site content.

Each fixture must use `channel-protocol-fixture/v1`, match the channel and
direction encoded by its directory, and use one of the evidence statuses
accepted by `fixtures/channel-protocol-fixture.schema.json`.

The `environment` object records evidence provenance for a capture. It is not a
Runtime dotenv file or a configuration source.

Before committing:

1. Replace reusable credentials, signatures, cookies, tokens, and secrets with
   `[REDACTED]`.
2. Replace account, conversation, message, filename, and URL identifiers with
   stable placeholders such as `<user-1>` or `<message-1>`.
3. Keep only purpose-written test content; never commit real user messages.
4. Mark documentation-derived contract seeds as `documented`. Only real,
   reproducible captures may use `tested-*` or `unstable`.
5. Record the source, environment, redactions, conclusion, and limitations.
6. Run `pnpm fixtures:validate`.

The validator provides structural and basic credential checks; it does not
replace manual privacy review.

## 当前版本实测

本目录记录的是平台当前版本的行为证据，用于确定 channel 应统一的行为，不以适配器的静态能力声明代替平台实测。结果与契约建议见 [行为矩阵](channel-behavior-matrix.md)。`documented` 与 `tested-*` 样例分别保留，不将文档种子升级为实测证据。

```bash
pnpm build
pnpm fixtures:probe:cli
pnpm fixtures:validate
pnpm fixtures:replay
```

CLI 探测启动真实独立 Runtime 和 CLI 子进程，TUI 控制器通过真实 Admin API 连接它。使用临时配置、随机端口和随机管理令牌，结束时关闭所拥有的进程；不会连接现有管理服务。CLI 样例使用 `terminalInput` 和 `terminalOutput`，其中成功 JSON 的 stdout 解析为对象保存，错误保留 stdout/stderr 和退出码。TUI 样例保留命令及控制器输出，未覆盖终端渲染。

NapCat 探测需要 Node.js 24、已登录的服务，以及明确指定的测试账号和群。以下命令会真实发送测试文本、引用、@、小文件和图片，随后撤回成功发送的消息，不应对非测试目标执行：

```powershell
$env:NAPCAT_WS_URL = 'ws://127.0.0.1:3001'
# NAPCAT_TOKEN 写入本地 .env，或在服务所在机器设置 NAPCAT_CONFIG 指向 OneBot 配置
$env:FIXTURE_PRIVATE_ID = '<authorized-private-id>'
$env:FIXTURE_GROUP_ID = '<authorized-group-id>'
pnpm fixtures:probe:napcat
```

支持 `FIXTURE_MODE=listen`（只监听）、`history`（只查询标记消息）、`image`（只复核图片并撤回）、`cleanup`（仅撤回近期专用测试消息），默认执行完整发送矩阵。`FIXTURE_MARKER` 指定测试标记，`FIXTURE_LISTEN_MS` 指定最长 60000ms 的监听窗口。文件上传和消息撤回是独立动作，撤回消息不能作为群文件已删除的证据；`cleanup-files` 仅用于匹配专用测试文件名且上传时间不早于 `FIXTURE_AFTER` 的文件。

远程采集可将脚本通过 SSH 标准输入交给服务机器的 Node.js 24，从目标部署目录执行。设置 `FIXTURE_STDOUT=1` 输出脱敏 JSONL，凭据只在远端读取，不复制原始配置。保存输出后导入：

```bash
node tools/channel-fixtures/import-capture.mjs test-results/channel-protocol/napcat.jsonl
pnpm fixtures:validate
pnpm fixtures:replay
```

采集过程未收到响应时返回非零退出码，不能据此标记平台不支持。收到与预期不符的响应时保留 `tested-partial` 证据并返回非零退出码。预期中的未知动作拒绝则是成功验证了错误行为。没有带标记的推送时仅报告未验证，不生成伪造的入站样本。`history-*` 样例来自历史查询，不能证明实时推送、断线恢复或消息不丢失。

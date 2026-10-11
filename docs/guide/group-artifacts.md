# 0.1 群聊工件助手

0.1 的任务入口是被触发的群聊消息：模型读取当前会话的 DAG 历史，在本地 Docker 中运行 Python 生成文件，再将文件内容直接上传到来源群。它不提供代码仓库编辑、Git/PR 或通用 Workflow 编排。

## 部署

准备 Node.js 24、pnpm 9.15.0、运行中的 Docker Linux 容器引擎、支持工具调用的 OpenAI-compatible 模型，以及已登录并启用正向 WebSocket 的 NapCat。机器人必须在目标群中且具有上传群文件的权限。

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm verify
docker build -t synapse-artifacts:0.1 deploy/artifacts
node tools/artifact-formats-smoke.mjs
```

部署镜像提供 `python-docx`、`openpyxl`、`reportlab`、`matplotlib` 和 Noto CJK 字体，可以生成 DOCX、XLSX、PDF、PNG，也可以使用 Python 标准库生成 CSV、JSON、文本等文件。Runtime 执行时不会拉取镜像、安装依赖或联网；额外依赖由部署者提前加入镜像。

在本地 `.env` 中填写以下变量，文件已被 Git 忽略：

```dotenv
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_API_KEY=replace-with-local-secret
MODEL_NAME=your-tool-capable-model
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_TOKEN=replace-with-local-secret
QQ_BOT_ID=your-bot-qq-number
```

使用专用示例启动：

```bash
node apps/runtime/dist/cli.js start --config examples/group-artifacts.config.toml --env-file .env
```

示例默认只响应 @机器人的群消息，数据写入 `.synapse/group-artifacts`。配置内的相对路径以配置文件位置解释；把配置复制到其他目录时，同步调整 `runtime.dataDir` 和 `prompts.catalogPath`。

必须同时启用 `container.enabled`、Prompt Bundle 和 `container.execute`、`channel.qq.upload_group_file`、`channel.qq.send_group_message` 三项权限。默认配置关闭容器，最小 echo 示例不具备工件生成能力。QQ Official 和未声明 NapCat 群文件能力的频道不会向模型暴露这两个工具。

## 使用与交付

向群发送“@机器人 生成一份包含三行示例数据的销售表格，保存成 XLSX 并上传群文件”。正常流程是：

1. `container.run` 接收 Python 脚本和要收集的单层文件名，在独立的 `/work` 中执行
2. Runtime 校验文件数量、大小和类型，生成工件 ID、名称、大小和 SHA-256
3. `artifact.upload` 只接收工件 ID，Runtime 从真实入站事件绑定目标群
4. NapCat 收到 `base64://` 文件内容后上传为群文件，Runtime 保存平台回执并回复实际结果
5. 运行输入、工具终态、工件引用和最终回复进入 DAG，后续对话可以查询或继续加工

后续请求可以通过 `container.run.inputs` 引用同一会话已有的工件 ID。每次执行仍使用新容器，输入按原始文件名放入 `/work`，不延续前一个容器的进程或临时目录。0.1 尚未实现群成员上传的任意附件自动下载为输入工件。

只有 `artifact.upload.status = succeeded` 表示平台已确认上传。单纯生成文件或模型说“已完成”不构成交付凭据。NapCat 可能不返回 `file_id`，此时仍以其明确成功回执为准。

## 隔离和限额

容器无网络、无宿主目录挂载、无 Docker socket，使用非 root 用户、只读根文件系统和临时工作盘。模型不能选择容器镜像、宿主命令、挂载路径或目标群。宿主只接受声明的单层普通文件，拒绝路径穿越、隐藏文件、符号链接、硬链接和超限内容。

默认每次运行限时 120 秒、512 MiB 内存、1 CPU、64 MiB 工作盘，最多同时执行 2 个容器。单次最多收集 8 个工件，单文件 5 MiB、总计 10 MiB，日志 8 KiB；工件二进制存储限额为 256 MiB。完整配置见 [Container Schema](../reference/config.md#container)。这是本地 Docker 隔离，不提供面向互不信任租户的沙箱服务。

## 故障与恢复

| 情况                                 | 当前行为与处理                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Docker 未启动或镜像未构建            | 工具明确失败；启动引擎、构建配置镜像后提出新请求                                      |
| 脚本错误、超时、非法文件或日志超限   | 尝试清理本次容器；确认清理后，模型可以在同轮修正脚本                                  |
| 容器清理失败                         | 工具抛出错误并停止该轮后续工具调用；管理员检查 Docker 状态及 `synapse.work=true` 容器 |
| 存储额度用尽                         | 拒绝保存新工件，不静默删除旧文件；管理员按下述流程维护                                |
| 平台明确拒绝上传                     | 保存 `failed` 回执并报告失败，不将链接当作群文件                                      |
| 上传超时、断网、异步受理或回执不完整 | 保存 `uncertain`，要求核对群文件，不自动重复上传                                      |
| 上传开始后 Runtime 退出              | 磁盘占位阻止相同工件再次上传；人工核对群文件后决定下一步                              |
| 重复入站事件或已完成调用恢复         | 复用持久化结果，避免重复运行和已确认的外部动作                                        |

上传去重以会话、频道、群、工件 ID 为键，跨调用 ID 和重启生效。`failed` 回执同样不会自动重试；0.1 没有管理员重置回执或自动补偿接口。核实未交付并解决问题后，可以由用户明确提出重新生成并上传的新请求，不能由模型自动换工件规避未知结果。

`dataDir/artifacts` 保存 UUID 命名的二进制和归属清单，`dataDir/artifact-deliveries` 保存上传占位和终态回执，`runtime-context.sqlite` 保存 DAG、消息与工具事件。工件按 Session 隔离，即使两个群共享 Workspace 也不能互相读取。

0.1 不做自动过期清理。备份或维护前先停止 Runtime，同时备份数据库、工件和回执目录；只移除已确认不再需要的工件 `.bin` 与同名 `.json`。删除会使旧 ID 无法继续加工，但不会撤回群文件。保留上传回执以维持去重语义。存储限额统计二进制，数据库、清单和回执仍需由部署者监控磁盘占用。每个数据目录只运行一个 Runtime 进程。

## 验收

```bash
pnpm verify
docker pull python:3.13-slim
pnpm container:smoke
node tools/artifact-formats-smoke.mjs
```

启用真实容器的生产装配集成测试，在 PowerShell 中执行：

```powershell
$env:SYNAPSE_TEST_DOCKER = '1'
pnpm --filter @synapse/runtime-server exec vitest run src/server/runtime-artifacts.test.ts
Remove-Item Env:SYNAPSE_TEST_DOCKER
```

这项集成测试使用真实 Docker，并以受控模型和 NapCat HTTP 替身检查上传字节、目标群、DAG 回流和重启去重。真实账号部署后，还需在目标群确认文件可见、可下载、内容正确，并让助手回答“刚才交付了什么”。仓库自动化验收不等同于真实账号联调，验证记录见[闭环状态](../reference/closure-status.md)。

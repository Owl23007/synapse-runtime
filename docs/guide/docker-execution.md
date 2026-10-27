# Docker 执行与产物交付

Runtime 的 `docker.run` 工具按需启动 Linux 容器，实际执行模型提供的命令，提取产物并随当前回复交付。空闲时不运行执行容器；每次调用使用全新工作区。推理和工具执行先完成，后置表达策略只调整文本格式，保留真实附件。

`docker.run` 与 `container.run` 共用 ArtifactStore、会话归属、最终产物选择和群文件上传回执。前者执行 shell 并自动交付最终回复附件，后者执行 Python 后由 `artifact.upload` 显式交付；两者在生产运行时都返回工件 ID，不把文件 Base64 写入工具、回复或 DAG 事件。

## 部署

先确保 Docker 服务可用，并在仓库根目录构建执行镜像：

```sh
docker build -t synapse-execution:local deploy/execution
```

镜像预装 Python、python-pptx、Pillow、openpyxl、reportlab 和 matplotlib，可生成 PPT、图片、表格和 PDF。容器内没有网络，请预先把额外依赖和字体加入自定义镜像，镜像必须保留 `python` 命令。

在部署配置启用工具和权限：

```toml
[tools.docker]
enabled = true
image = "synapse-execution:local"
timeoutMs = 120000
memoryMb = 512
cpus = 1
maxArtifactBytes = 10000000

[permissions]
"execution.docker.run" = "allow"
"channel.qq.send_media" = "allow"
"channel.qq.upload_group_file" = "allow"
"channel.qq.send_group_message" = "allow"
"channel.qq.send_private_message" = "allow"
```

权限表采用整表替换，应保留现有部署需要的其他权限。工具默认禁用，启用后仍需显式执行授权；无授权时不会对模型暴露此工具。修改后重载 Runtime。已有 Prompt Bundle 也需同步示例中的工具执行策略，避免旧人格指令继续让模型拒绝执行。

## 执行与验收

工具输入示例：

```json
{ "command": "printf '真实文件内容' > demo.txt", "artifacts": [{ "path": "demo.txt", "type": "file" }] }
```

命令在 `/workspace` 内执行，`artifacts` 使用该目录下的相对路径，最多八个，合计大小受配置限制；图片使用 `image` 类型。文件先保存到 `dataDir/artifacts`，模型与持久事件只保存元数据和 `artifact://<id>` 引用。Base64 仅用于容器传输与适配器实际发送边界。命令非零退出不交付产物，模型可根据观察修正命令。目录不存在、产物缺失、越界、超限和 Docker 故障均返回工具失败，不能据此宣称成功。

统一工件库受 `container.maxArtifactBytes`、`container.maxTotalBytes` 和 `container.storageMaxBytes` 约束，即使 `container.enabled=false` 仍生效；Docker 侧的 `tools.docker.maxArtifactBytes` 另外限制每次提取总量。默认工件库单文件上限为 5 MiB，需要更大的文件时同时调整提取和存储限额。

同一 Run 内同名同内容复用工件 ID；同名修订版默认替换旧版选择。可以单独调用以下管理操作，无需运行容器，不能与 `command` 合并：

```json
{ "selectArtifactIds": ["本轮最终工件 UUID"] }
```

```json
{ "discardArtifactIds": ["本轮草稿 UUID"] }
```

`selectArtifactIds` 替换整个最终集合，空数组表示本轮不交付附件；`discardArtifactIds` 移除指定草稿。废弃不删除文件或平台回执，也不撤回已经发送的群文件。显式选择可恢复本轮候选。最终回复过滤未选中和重复 ID，只交付当前选中的文件。跨 Run 或跨会话不复用生成身份，避免混淆不同请求的交付意图。

容器不挂载宿主目录和 Docker socket，禁用网络，使用非 root 用户和只读根文件系统，限制 CPU、内存、进程数及临时目录容量。执行结束或超时后清理具名容器。Runtime 进程被强行终止时仍可能遗留容器，可用 `docker ps --filter name=synapse-execution-` 检查，按名称清理。

NapCat 群聊文件使用 `upload_group_file`，私聊使用 `upload_private_file`；图片走图片消息。附件在适配器边界转换为 Base64，不依赖 Runtime 与 NapCat 共享路径。群文件逐项保存上传占位和平台回执，与 `artifact.upload` 共用去重机制；文件上传成功而文本回复失败时，时间线保留工件成功和回复失败两个事实。`generated`、`selected`、`discarded` 均不表示交付成功，只有平台成功回执算交付。未知结果保持 `uncertain`，不自动重放。私聊和图片仍依赖消息整体回执，部分成功需人工核查。其他提供商的资源支持取决于适配器，本链路面向 NapCat。

群聊发送“生成一个示例 PPT 并发送”后，日志应包含 `docker.run` 的工具步骤和频道投递结果，QQ 应收到可打开的附件。只有 `model:succeeded finish=stop` 的文本回复不能证明执行或交付成功。需要澄清时可以只回复文字，工具调用由模型决定，Runtime 不强制把每条聊天都转成容器任务。

构建项目与镜像后运行 `pnpm test:docker`，可用真实 Docker 检查 PPT/图片生成、缺失产物、符号链接越界、体积超限、非零退出、超时与容器回收；此命令不向 QQ 发消息。

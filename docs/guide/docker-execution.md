# Docker 执行与产物交付

Runtime 的 `docker.run` 工具按需启动 Linux 容器，实际执行模型提供的命令，提取产物并随当前回复交付。空闲时不运行执行容器；每次调用使用全新工作区。推理和工具执行先完成，后置表达策略只调整文本格式，保留真实附件。

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
"channel.qq.send_group_message" = "allow"
"channel.qq.send_private_message" = "allow"
```

权限表采用整表替换，应保留现有部署需要的其他权限。工具默认禁用，启用后仍需显式执行授权；无授权时不会对模型暴露此工具。修改后重载 Runtime。已有 Prompt Bundle 也需同步示例中的工具执行策略，避免旧人格指令继续让模型拒绝执行。

## 执行与验收

工具输入示例：

```json
{ "command": "printf '真实文件内容' > demo.txt", "artifacts": [{ "path": "demo.txt", "type": "file" }] }
```

命令在 `/workspace` 内执行，`artifacts` 使用该目录下的相对路径，最多八个，合计大小受配置限制；图片使用 `image` 类型。返回给模型的观察只包含退出码、截断后的标准输出和错误输出、产物元数据；附件数据独立进入规范输出和恢复记录。命令非零退出不交付产物，模型可根据观察修正命令。目录不存在、产物缺失、越界、超限和 Docker 故障均返回工具失败，不能据此宣称成功。

容器不挂载宿主目录和 Docker socket，禁用网络，使用非 root 用户和只读根文件系统，限制 CPU、内存、进程数及临时目录容量。执行结束或超时后清理具名容器。Runtime 进程被强行终止时仍可能遗留容器，可用 `docker ps --filter name=synapse-execution-` 检查，按名称清理。

NapCat 群聊文件使用 `upload_group_file`，私聊使用 `upload_private_file`；图片走图片消息。附件以 [NapCat 支持的 base64 资源](https://napneko.github.io/onebot/napcat) 传递，不依赖 Runtime 与 NapCat 共享路径。上传失败记录投递失败，不会静默把文件降为文字；发生部分投递后应先人工核查，避免重试造成重复附件。其他 QQ 提供商是否支持这类资源取决于其适配器，当前此链路面向 NapCat。

群聊发送“生成一个示例 PPT 并发送”后，日志应包含 `docker.run` 的工具步骤和频道投递结果，QQ 应收到可打开的附件。只有 `model:succeeded finish=stop` 的文本回复不能证明执行或交付成功。需要澄清时可以只回复文字，工具调用由模型决定，Runtime 不强制把每条聊天都转成容器任务。

构建项目与镜像后运行 `pnpm test:docker`，可用真实 Docker 检查 PPT/图片生成、缺失产物、符号链接越界、体积超限、非零退出、超时与容器回收；此命令不向 QQ 发消息。

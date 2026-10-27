# 数据备份与恢复

维护命令独立于 Runtime，不加载配置凭据，也不启动频道或模型。操作前先停止使用该数据目录的 Runtime；维护与生产实例共用目录独占锁，目录仍在使用时会拒绝备份。

## 备份范围

备份包含 `runtime-context.sqlite` 的一致性快照、`artifacts` 下的二进制与清单（包括最终选择），以及 `artifact-deliveries` 下的上传占位与回执。SQLite 快照包含尚未 checkpoint 的 WAL 数据，不依赖直接复制活动数据库文件。

`backup-manifest.json` 记录版本、时间、数据库版本，以及每个文件的路径、字节数和 SHA-256。维护不会迁移原数据库，也不会重置上传回执或重新发送文件。配置、环境变量、凭据、容器镜像和外部平台文件不在备份范围内，需要部署者单独保存。

## 命令

先运行 `pnpm build`。以下路径以**当前工作目录**为基准，`--data-dir` 应指定配置解析后的实际数据目录。目标目录必须尚不存在，父目录必须已存在，源目录与目标目录不能互相包含。

```powershell
# 示例：在仓库根目录运行，先停止 Runtime
New-Item -ItemType Directory -Force .synapse-backups
pnpm maintenance backup --data-dir .synapse/group-artifacts --output .synapse-backups/snapshot-20261027
pnpm maintenance verify --backup .synapse-backups/snapshot-20261027
pnpm maintenance restore --backup .synapse-backups/snapshot-20261027 --data-dir .synapse/group-artifacts-restored
```

安装服务端包时，同样的命令入口为 `synapse-maintenance`。`pnpm maintenance --help` 显示参数；成功返回 JSON 摘要，失败退出码为 `1`。脚本需要直接解析 JSON 时使用 `node apps/runtime/dist/maintenance.js`，避免 pnpm 的命令提示行。

恢复会逐文件校验字节数与 SHA-256，并检查 SQLite 完整性和外键。完成后，在 Runtime 配置中把 `runtime.dataDir` 指向恢复目录，再启动并检查历史运行、工件下载和平台回执。不要直接在备份目录上启动 Runtime，生产目录锁会拒绝这类启动。

恢复保留原有运行状态；随后正常启动仍会执行当前 Runtime 的迁移与恢复规则，结果未知的外部动作不会自动重放。备份工具能保存较新版本数据库，不代表旧版本 Runtime 能读取它；升级回滚仍需匹配数据库兼容版本。

## 失败与限制

- 备份或恢复中途失败会保留 `.maintenance-incomplete`，生产 Runtime 拒绝启动半成品目录。确认失败原因后换一个新目标目录重试，不要手动移除标记继续使用
- 已存在的目标目录不会被覆盖，原数据不会被删除。维护失败也会释放目录锁；不要通过删除锁文件绕过正在运行的实例
- 文件被改动、摘要不符、路径穿越、重复路径、符号链接和硬链接会导致失败。工件及回执目录仅支持当前存储布局的单层普通文件，备份最多包含 100,000 个文件
- 目录锁约束生产 Runtime 与此维护工具；维护期间不要使用其他进程或嵌入式数据库连接修改源目录。备份清单用于内容完整性校验，不是签名认证；备份目录应由可信管理员保管
- 当前没有自动过期清理、工件墓碑、历史内嵌附件迁移或磁盘用量界面。不要手工删除仍被历史运行、最终选择或未决动作引用的文件，也不要删除用于去重的上传回执

自动化测试覆盖含 WAL 的备份、恢复后读取运行、工件及回执逐字节保留、活动实例锁、目标覆盖拒绝、内容损坏、非法清单、硬链接、失败目录禁止启动及不触发迁移。真实部署仍应定期演练恢复，确认目标机器上的配置、凭据和镜像也可用。

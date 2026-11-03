# 持久资源备份与恢复

维护命令是独立离线入口，不启动 Runtime，不加载生产配置、环境变量文件、模型或频道凭据。先停止使用这些存储目录的 Runtime，再执行维护操作。

```sh
pnpm maintenance backup --data-dir /old/data --skills-dir /old/skills --output /backups/runtime-20261103
pnpm maintenance verify --backup /backups/runtime-20261103
pnpm maintenance restore --backup /backups/runtime-20261103 --data-dir /new/data --skills-dir /new/skills
```

备份和恢复目标必须是全新目录，外部目标的父目录需要提前创建。恢复时可以改变 `dataDir` 与 `capabilities.skillsDirectory`；Skill 目录也可以放在新数据目录的独立子树中，但不能占用 `assets`、`artifacts`、`artifact-deliveries` 等数据资源路径。恢复完成后，在新部署配置中指定这两个目录，再启动 Runtime。

存在 Skill 快照时，备份必须显式提供 `--skills-dir`，恢复必须指定全新的 Skill 目标目录。没有 Skill 的部署可以省略该参数。旧安装记录仍带绝对路径时，维护工具可以直接从记录中的目录读取，但推荐始终明确提供 Skill 存储根。

## 备份范围与持久化关系

| 资源                | 持久化关系与恢复策略                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite              | 保存会话、历史 Run、Asset 来源与所有版本、附件引用、Skill 安装身份、工作区授权和 Run 依赖快照，使用 SQLite 一致性备份保留尚未 checkpoint 的 WAL 数据             |
| Artifacts           | `dataDir/artifacts` 中的 JSON 保存索引、选择与处置状态，二进制保存实际内容，全部纳入备份；核对索引及已记录的 Run 工件引用                                        |
| Artifact Deliveries | `dataDir/artifact-deliveries` 保存副作用前的 `.pending` 占位和交付回执，全部保留，恢复不会因此自动重发                                                           |
| Asset Blobs         | 每条 `asset_versions` 都要求存在 `dataDir/assets/blobs/<摘要前缀>/<摘要>`，包括历史、软删除资源及挂载文件的已物化版本；所有已发布 Blob 文件纳入备份              |
| Skill Snapshots     | 新安装以 `contentDigest` 定位 `skillsDirectory/snapshots/<摘要>`，保留所有已发布快照与历史安装版本；从外部目录导入时先复制为托管快照，之后不再依赖原目录         |
| 外部资源            | 远程平台文件、只读挂载原目录、MCP 服务、部署配置和凭据不复制；只有来源记录、没有 `asset_versions` 的附件允许尚未物化，恢复后首次读取仍依赖可用的来源和新部署配置 |
| 临时资源            | Blob 与 Skill 的 `staging`、运行锁文件、SQLite WAL/SHM 由恢复后运行时重新建立，不属于已发布内容                                                                  |

## 清单与兼容边界

Manifest v2 的每个文件由逻辑根 `data` 或 `skills`、根内相对路径、字节数和 SHA-256 描述。备份目录内 `data` 文件直接放在根目录，`skills` 文件放在 `skills/` 子目录；清单不保存需要原样还原的宿主绝对路径。

旧数据库的 `install_path` 仍可供原部署读取。离线备份先验证旧目录的全部文件、内容摘要与安装元数据，再将其复制到按摘要组织的快照目录，并仅在备份的 SQLite 副本中将 `install_path` 规范化为 `NULL`。安装 ID、内容摘要、工作区绑定和历史 Run 依赖保持不变，安装不可变约束保留。新安装的 `install_path` 为 `NULL`，运行时通过当前配置的 Skill 根读取。

旧 Manifest v1 没有完整覆盖 Blob 和 Skill，验证与恢复会明确拒绝。需要保留原部署及其旧 Skill 目录，用新维护命令重新生成 v2 备份；不能通过手工升级清单版本弥补缺失数据。

## 校验与失败处理

备份前检查数据库引用的托管文件，备份提交前、独立验证时和恢复完成前再次检查文件大小、摘要、SQLite 完整性及外键、附件版本和 Run 依赖、Skill 文件索引与整体内容摘要。仅重新计算清单摘要无法掩盖数据库引用的内容损坏。

清单拒绝路径穿越、Windows 特殊路径、文件与目录冲突、大小写重复路径；目录和文件拒绝符号链接，文件拒绝硬链接。离线维护持有原有操作系统级独占锁，目标目录拒绝覆盖。

失败时保留 `.maintenance-incomplete`，不提交可验证的备份，也不允许 Runtime 启动部分恢复的数据或 Skill 目录。原部署保持原状。不要删除未完成标记来尝试启动，应修复源资源或选择完整备份，恢复到另一组全新目录。

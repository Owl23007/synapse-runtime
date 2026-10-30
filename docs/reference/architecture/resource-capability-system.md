# Resource & Capability 架构

| 模块                            | 责任                                           |
| ------------------------------- | ---------------------------------------------- |
| protocol / channel              | 真实通知、平台动作与统一回执                   |
| runtime-core                    | Workspace、资源/能力约束、Run 和引用           |
| storage/sqlite                  | 共享连接、复合归属约束、索引、快照、绑定与审计 |
| runtime-resources               | 标准 Skill、受限解包、目录发现、PromptBundle   |
| tool-runtime                    | 可信作用域、权限、可见性、调用和恢复           |
| tool-mcp                        | 官方协议客户端与连接生命周期                   |
| tool-web                        | 固定 DNS 的有界 HTTP                           |
| apps/runtime/composition        | 获取器、凭据注入、工具装配、工件桥接           |
| routes / runtime-client / webui | 传输契约和独立的管理界面                       |

复用 workspaces/workspace_bindings，用 session_workspaces 显式关联 Native Session。资源扩展和现有追踪扩展一样独立记账，初始化迁移放在数据库事务中，拒绝未知版本。

文件链路：通知/附件 → ResourceIngress → Workspace 索引 → 显式读取 → 平台定位与受限获取 → staging/Blob → SQLite 版本 → Run/Task 引用 → 工件选择与发布 → 原交付状态机。被动发现没有 Run、Transcript 或 DAG 副作用。

能力链路：Catalog → 明确 release/commit → staging 校验 → 内容快照 → Workspace 绑定 → Run 工具/Skill 视图 → 调用时再次授权。PromptBundleCompiler 继续负责生效摘要；MCP 保存配置和观察事实，不声称锁住远端代码。

没有复刻对象存储集群、第三方商店或组织权限系统，也没有为每个概念堆叠 Registry/Manager 层。

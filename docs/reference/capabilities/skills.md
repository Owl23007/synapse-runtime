# Agent Skills

标准 Skill 使用 SKILL.md 的 YAML frontmatter 与 Markdown 正文，支持 references、assets、scripts 等辅助内容。名称、描述、兼容信息和文件体积均校验。标准字段与 Synapse 的 Workspace 策略分别处理，外部 allowed-tools 不授予权限。

启用后的 Skill 先向模型发布目录元数据，`skill.read` 按需加载说明，`skill.read_resource` 分页读取辅助文件。显式激活继续使用 PromptBundleCompiler 的 Skill 区块和摘要。工作区可配置 requiredTools，缺少必需工具时拒绝激活。

安装使用 staging，解包前检查 ZIP 路径、链接、重复项、大小与数量。Git 来源必须是完整 40 位 commit，可选仓库内子目录；不接受分支名或任意启动命令。只解压选定子树，Git 管理元数据不进入快照。

压缩包最多 20 MiB；选定内容最多 512 个文件、20 MiB，单文件最多 2 MiB。工具每次最多返回 16000 字符。路径不能离开安装根，读取时重新校验文件摘要。scripts 仅保存和展示，不执行；skill.execute_script 与宿主 Shell 不在本阶段范围内。

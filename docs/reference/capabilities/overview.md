# 能力系统

Runtime 安装能力，Workspace 启用确定版本，Run 固定依赖快照。发现、安装、授权与调用分别处理：目录搜索不下载包，安装不执行脚本，也不自动为工作区启用。

Capabilities 页面提供发现、已安装、更新与连接。详情显示来源、许可证、内容摘要、文件和脚本；审阅后选择工作区启用。切换和回滚只改变绑定指针，旧安装快照继续保留。停用在实际工具调用时再次检查。

```toml
[capabilities]
skillsDirectory = "./data/skills"
autoCheckUpdates = true
checkIntervalMs = 3600000
allowedSources = ["clawhub", "github", "mcp-official"]

[[capabilities.catalogs]]
id = "clawhub"
type = "clawhub"
enabled = true

[[capabilities.catalogs]]
id = "mcp-official"
type = "mcp-registry"
enabled = true
```

Skill 快照保存到 skillsDirectory/snapshots 的内容摘要目录。Run 记录文件版本、Skill 安装 digest、现有 PromptBundle 的 SkillSet/ToolSet digest，以及 MCP 配置和已观察工具集合。被动索引不会创建额外 DAG 节点。

继续阅读：[Skills](./skills)、[MCP](./mcp)、[目录](./registries)、[更新](./updates)、[执行边界](./execution-security)

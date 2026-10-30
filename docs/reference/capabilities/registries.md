# 目录与来源

首发目录是 ClawHub Skills 与官方 MCP Registry，另支持 GitHub 固定提交。浏览器只访问 Synapse Admin API。目录结果是外部元数据，不代表执行安全认证。

ClawHub 保留作者限定的包身份，托管包选择精确 release。GitHub handoff 只采用通过校验的仓库、commit 和相对路径，由 Runtime 构造下载地址，不信任任意 archiveUrl。来源审核信息保留为人工审阅数据。

MCP Registry 搜索固定 version=latest；安装选择具体发布版本与远程 HTTP 端点。Registry 是目录，不负责启动或保证远端代码可重现。

JSON 元数据缓存一分钟，最多 128 项；429 按 Retry-After 做来源级退避，不循环重试。搜索与版本查询都不会安装包。

官方参考：[ClawHub API](https://github.com/openclaw/clawhub/blob/main/docs/api.md)、[MCP Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml)、[Agent Skills 规范](https://agentskills.io/specification)

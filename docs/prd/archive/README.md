# PRD 归档

此目录用于存放已完成且不再维护的 PRD。路线图组件会自动忽略该目录中的文档，并将路径包含 `/archive/` 的文档显示为 `archived`。

新归档的文档应在 frontmatter 中设置 `status: archived`，以保留状态语义。历史文档即使没有 frontmatter，只要位于本目录，也会按归档处理。

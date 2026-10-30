# 文件资源概览

Files 是现有 Workspace 的长期资源入口。Native 会话可以共享资源工作区，QQ 群沿用既有工作区解析；会话 ID 与 Workspace ID 是不同身份。

QQ 文件通知只保存稳定来源与元数据，不下载内容，不创建 Run，不保存未触发消息正文。用户预览、下载或 Agent 读取时才物化内容。Native 文件通过两阶段上传写入 Blob；真实内容校验完成后才发布不可变版本。

Run 固定版本 ID 与 SHA256。替换只推进当前头，软删除只隐藏逻辑入口，历史引用保留；本地操作不联动 QQ 远端文件。选中工件在交付前导入 Files，原 Artifact 选择与交付回执语义继续生效。

## 使用流程

1. 创建 Native 会话或接收 QQ 文件，使现有 Workspace 持久化
2. 在 Files 选择工作区，上传文件或同步 QQ 来源
3. 在会话中添加附件，固定内容版本
4. Agent 使用 `asset.search` 搜索元数据，使用 `asset.read` 分页读取
5. 从 Files 查看关联 Run，或在 Run 的「资源与能力」中查看依赖快照

## 配置

```toml
[files]
enabled = true
maxNativeUploadBytes = 20971520
maxRemoteFetchBytes = 52428800
maxConcurrentFetches = 2
cacheMaxBytes = 1073741824
# 可信 NapCat 返回私网下载地址时，精确批准目标主机，不含协议和路径
remoteAllowedHosts = []
```

默认权限允许 `asset.read` 与 `skill.read`，`asset.mount.read` 和 MCP 调用仍需明确配置。显式提供 permissions 表会替换默认表，应同时保留实际需要的频道与其他工具权限。上传/获取限额是 Runtime 的预算，不代表 QQ 平台真实上限。

Blob 位于 `<dataDir>/assets/blobs/`，按实际内容摘要去重，对外不能直接按哈希访问。容量达到上限时拒绝新写入，不自动删除历史内容。启动时清理超过一小时的 staging 残留。

详见：[版本](./assets)、[QQ](./qq-files)、[Native](./native-upload)、[挂载](./mounts)、[English](./overview.en)、[能力管理](../capabilities/overview)

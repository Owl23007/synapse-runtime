# Native 上传与附件

先向 `POST /admin/workspaces/:id/assets/uploads` 提交名称、声明大小、MIME 和幂等键：

```json
{ "name": "需求.pdf", "size": 12345, "mime": "application/pdf", "idempotencyKey": "upload-key" }
```

再向 `PUT /admin/assets/uploads/:uploadId/content` 发送原始 application/octet-stream，不使用 multipart。实际大小必须匹配声明；相同键与不同参数或内容冲突返回 409。初始化一小时有效，完成后的同内容重试复用版本。

Runtime 写 staging、计算 SHA256、识别实际类型、原子发布 Blob，再以 SQLite 事务发布版本。中断或超限不会创建版本。当前 HTTP 框架在预算内缓冲原始请求体，Blob 边界支持异步字节流。

Native 会话创建时绑定现有 Workspace，默认多个会话共享 personal:runtime-admin；管理 API 也可指定已有 workspaceId。同一个 Session 的绑定不可改写。

```json
{
  "sessionId": "native-session",
  "text": "总结附件",
  "idempotencyKey": "run-key",
  "attachments": [{ "assetId": "asset-id", "versionId": "version-id" }]
}
```

接受 Run 前验证可信 Session 归属、每个版本所属 Workspace 和实际 Blob 完整性，然后固定引用。模型不能提供宿主路径。每次最多 20 个附件。

Files 支持图片、PDF、文本预览与下载。内容设置 Content-Type、CSP、nosniff，支持单个显式起始字节 Range；未知主动格式强制下载。认证放在请求头，令牌不出现在 URL 中。

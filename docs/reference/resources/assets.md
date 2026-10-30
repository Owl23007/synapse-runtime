# 资源与不可变版本

Asset 是工作区逻辑文件；AssetSource 是稳定来源；AssetVersion 是已保存并校验的真实内容；AssetReference 描述消息、Run、Task 或工件关系。远端文件尚未下载时没有版本。

SQLite 复合外键保证来源与资源同属 Workspace，版本与当前头属于同一 Asset。Run/Task 引用必须包含版本；空版本消息引用使用独立唯一索引去重。版本行不允许更新。

| 操作             | 管理 API                                               |
| ---------------- | ------------------------------------------------------ |
| 分页元数据       | `GET /admin/workspaces/:id/assets?q=&source=&cursor=`  |
| 来源、版本与关系 | `GET /admin/assets/:id`                                |
| 按需物化         | `POST /admin/assets/:id/materialize`                   |
| 确定内容         | `GET /admin/assets/:id/content?versionId=`             |
| 本地展示名       | `PATCH /admin/assets/:id`，正文 `{ "name": "新名称" }` |
| 新版本初始化     | `POST /admin/assets/:id/versions`                      |
| 本地软删除       | `DELETE /admin/assets/:id`                             |

所有 API 沿用 Admin 认证、Origin 与远端地址策略。管理员拥有跨工作区管理权；Agent 的工作区只能由可信 Session 注入，Asset ID 不是授权凭证。内容接口还可用 workspaceId 显式限定归属。

软删除保留来源、版本和 Run 引用。管理员以明确 versionId 读取历史内容，已固定引用的 Run 继续使用旧版本；新 Run 不能把已删除资源作为新输入。

`asset.read` 支持 offset，每次最多 16000 字符。PDF 提取最多 200 页、200 万字符，再分页返回；其他二进制返回类型与版本元数据。内容列表与 Prompt 编译不会隐式下载文件。

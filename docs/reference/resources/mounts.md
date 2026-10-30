# 只读目录映射

Mount 是实时目录视图，不批量导入 Asset。浏览器读取当前内容；保存为资源或 Agent 使用时复制为确定版本，后续目录变化不改写历史 Run。

```toml
[[files.mounts]]
id = "shared"
root = "/srv/synapse/shared"
urlPrefix = "/files/shared"
access = "authenticated"
readOnly = true
```

Files 可浏览目录并保存快照。直接内容 URL 为 `/files/shared?path=reports/input.txt`；根列表用 `/files/shared`，子目录列表增加 list=1。private 不提供直接浏览器 URL，authenticated 使用 Admin 认证，public 还需 allowPublic=true。管理返回值不包含宿主根路径，HTTP 写请求返回 405。

Agent 使用 `asset.mount_read`，需要独立用户权限 asset.mount.read，默认拒绝。工具只接收 Mount ID 与相对路径，返回固定资源版本，再使用 asset.read 提取内容。浏览器读取权不等于 Agent 读取权。

拒绝绝对路径、..、反斜杠、编码绕过、隐藏敏感目录与符号链接。读取前核对句柄和规范路径，过程中检测内容变化，变化时返回冲突。目录最多 200 项，内容使用远端获取体积预算。修改 Mount 配置或上传 HTTP 预算需要重启。

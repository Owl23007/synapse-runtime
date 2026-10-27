# WebUI 运行控制台

完成 `pnpm build` 后启动 Runtime，打开 `http://127.0.0.1:3766`，填写配置中的 Admin Token；未设置令牌的本地实例可留空连接。无需模型凭据的首次启动：

```bash
pnpm install --frozen-lockfile
pnpm build
node apps/runtime/dist/cli.js start --config examples/minimal.config.toml
```

没有频道消息时显示空态。实际运行需要连接频道；群文件闭环见[群聊工件助手](./group-artifacts.md)。控制台当前属于 0.1 开发实现，正式发布仍受[验收清单](../reference/v0.1-release-acceptance.md)约束。

## 检查一次运行

1. **总览**显示最近 50 次运行的状态分布，数字不是全历史统计
2. **运行记录**按状态、频道、会话和时间筛选，按接受顺序分页；筛选保存在页面链接中
3. **运行详情**检查时间线、模型输入输出、工具和权限记录。上下文页读取执行时保存的快照，后续 Ref 变化不会改变该快照
4. 从运行详情打开会话，进入**数据浏览**检查消息、Ref 和 Commit。点击父提交可继续追溯上下文来源
5. **工件**页显示会话归属和摘要，可通过认证请求下载；生成文件与平台交付是独立事实，交付回执在运行事件中检查

“结果待确认”表示外部动作已开始，但缺少可靠回执。先在频道核实消息或文件是否送达，不要盲目重新发送。“已中断”保留检查信息，页面不提供任意续跑或重放按钮。缺失 usage 或耗时表示未记录。

## 连接与安全

令牌只存在当前页面内存，不写入浏览器存储、URL 或下载链接。刷新后需要重新连接，运行链接和筛选仍然有效。模型输出以文本显示，不执行其中的 HTML。

生产页面仅连接同源 Admin。连接其他实例时，在浏览器中打开那个实例的管理地址。公开静态外壳不包含运行数据；查询、SSE 与下载继续受令牌、Origin 和远程地址配置保护。远程部署应设置 HTTPS、Admin Token、明确的 `allowedOrigins` 与 `allowedRemoteAddresses`。

运行流断开后自动重连并按持久游标补读；认证失效或协议不兼容会停止重试并显示提示。实例重载会重建订阅。历史无快照记录不会补造模型信息。

## 本地开发与验证

先启动 Admin 端口为 3766 的 Runtime，再执行 `pnpm webui:dev`。Vite 将 `/admin` 代理到该实例。

```bash
pnpm verify
pnpm test:webui
```

浏览器回归使用临时 SQLite、真实 Admin 服务及持久 SSE，种入明确的测试事实，不调用模型或外部频道。Windows 默认使用已安装的 Edge；Linux 使用 Playwright Chromium，先执行 `pnpm --filter @synapse/runtime-webui exec playwright install --with-deps chromium`。可用 `SYNAPSE_BROWSER_CHANNEL` 指定通道。

截图写入忽略版本控制的 `test-results/webui`。浏览器测试不替代真实模型和 NapCat 的交付验收。

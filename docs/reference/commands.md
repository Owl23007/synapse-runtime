# 命令

## Workspace Scripts

| Command             | 说明                                                       |
| ------------------- | ---------------------------------------------------------- |
| `pnpm build`        | 构建所有 workspace package                                 |
| `pnpm test`         | 运行所有 workspace 测试                                    |
| `pnpm typecheck`    | 对所有 workspace package 执行类型检查                      |
| `pnpm start`        | 使用 `examples/runtime.config.toml` 和 `.env` 启动 Runtime |
| `pnpm tui`          | 启动交互式控制台                                           |
| `pnpm tui:spawn`    | 启动本地 Runtime 并打开控制台                              |
| `pnpm docs:dev`     | 启动 VitePress dev server                                  |
| `pnpm docs:build`   | 构建 VitePress 静态站点                                    |
| `pnpm docs:preview` | 预览已构建的 VitePress 站点                                |

## Runtime CLI

```bash
synapse-runtime [command] [options]
```

命令：

| Command                | 说明                                     |
| ---------------------- | ---------------------------------------- |
| `start`                | 启动 runtime server                      |
| `serve`                | `start` 的别名                           |
| `console`              | 启动连接 Admin API 的交互式控制台        |
| `status`               | 以 JSON 输出 Admin API runtime status    |
| `logs`                 | 以 JSON 输出 Admin API 缓冲日志          |
| `channels`             | 以 JSON 输出 Admin API channels          |
| `channel enable <id>`  | 启用已配置 channel                       |
| `channel disable <id>` | 禁用已配置 channel                       |
| `reload`               | 重新加载 runtime config                  |
| `shutdown`             | 停止 runtime server                      |
| `connect <endpoint>`   | 将 Admin API endpoint 保存到 CLI profile |
| `profiles`             | 输出 CLI profiles                        |
| `use <profile>`        | 切换当前 CLI profile                     |

选项：

| Option                     | 说明                                            |
| -------------------------- | ----------------------------------------------- |
| `-c, --config <path>`      | Runtime config 文件，默认 `runtime.config.toml` |
| `--env-file <path>`        | 可选 env 文件，在配置展开前加载                 |
| `--admin-host <host>`      | 覆盖 Admin API host                             |
| `--admin-port <port>`      | 覆盖 Admin API port                             |
| `--admin-token-env <name>` | 从环境变量读取 Admin API token                  |
| `--endpoint <url>`         | Admin API endpoint                              |
| `--token <token>`          | Admin API bearer token                          |
| `--profile <name>`         | CLI profile 名称                                |
| `--profile-config <path>`  | CLI profile config 路径                         |
| `--spawn`                  | 仅 console 使用：在 TUI 内启动本地 Runtime      |
| `--tail <n>`               | logs 返回条数                                   |
| `-h, --help`               | 显示帮助                                        |

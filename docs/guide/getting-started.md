# 快速开始

## 前置要求

- Node.js 20 或更高版本
- pnpm 9.x
- 一个已配置的 Agent Provider；如果不配置，Runtime 会使用内置 echo fallback
- 至少一个启用的 channel，才能处理真实消息

## 安装依赖

```bash
pnpm install
```

## 构建与测试

```bash
pnpm build
pnpm test
pnpm typecheck
```

## 启动 Runtime

先从版本化示例创建当前部署自己的配置与凭据文件：

```bash
cp examples/runtime.config.toml runtime.config.toml
cp .env.example .env
```

`runtime.config.toml` 是部署态主配置，完整结构和普通配置值都应写在这里；`.env` 只为配置中的 `${VAR}` 提供脱敏值，或提供少量进程级覆盖。两者都不会提交到仓库。默认启动脚本读取这两个文件。

```bash
pnpm build
pnpm start
```

等价的直接命令：

```bash
node apps/runtime/dist/cli.js start \
  --config runtime.config.toml \
  --env-file .env
```

## 启动控制台

TUI 位于独立的 `apps/tui` 应用。连接已有 Admin API：

```bash
pnpm tui
```

启动独立的本地 Runtime 子进程，并通过 Admin API 连接：

```bash
pnpm tui:spawn
```

该脚本显式传入 `apps/runtime/dist/cli.js`。TUI 退出时回收自己启动的进程，连接已有服务时则只断开连接。无密钥试运行可执行：

```bash
node apps/tui/dist/cli.js --spawn --runtime-entry apps/runtime/dist/cli.js --config examples/minimal.config.toml
```

## 启动文档站

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

VitePress 文档源码位于 `docs`，PRD 统一存放于 `docs/prd`，并可从参考页或路线图进入。

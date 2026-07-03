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

默认启动脚本会读取 `examples/runtime.config.toml`，并加载 `.env`。

```bash
pnpm build
pnpm start
```

等价的直接命令：

```bash
node packages/runtime-server/dist/cli.js start \
  --config examples/runtime.config.toml \
  --env-file .env
```

## 启动控制台

连接已有 Admin API：

```bash
pnpm tui
```

启动一个本地 Runtime，并打开控制台：

```bash
pnpm tui:spawn
```

## 启动文档站

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

VitePress 文档源码位于 `docs`。已有 PRD 文件继续保留在同一目录，并从参考页链接进入。

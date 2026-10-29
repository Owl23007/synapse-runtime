# Runtime WebUI

React 19、TypeScript 与 Vite 应用，只通过 `@synapse/runtime-client` 访问 Runtime。

```text
src/
  app/                 连接入口、导航壳、类型化路由与 SSE 订阅
  features/
    workspace/         会话、对话、Context DAG、任务与工件
      components/      独立视图
      hooks/           状态与现有 API 编排
      lib/             纯展示、布局与兼容函数
    runs/              总览、运行列表与详情
    explorer/          数据浏览
    system/            频道、任务与设置
  shared/
    hooks/             跨页面的数据加载
    lib/               协议展示与安全格式化
    types/             页面服务上下文
    ui/                反馈、面板、图标与可降级材质
  styles/              Token、排版、共享组件与导航样式
config/                Vite 开发代理和测试夹具配置
```

`app` 装配页面，`features` 持有功能状态，`shared` 不依赖功能模块。工作台的 API 调用、分页游标、幂等键与切换隔离集中在功能 Hook；视图不新增 Runtime 领域规则。跨功能导航继续使用持久标识的 Hash 深链接。

页面通过 React `lazy` 分包，`Suspense` 与页面错误边界保留加载和重试入口。同一工作台的会话参数变化保留列表和折叠偏好。凭据仅在内存中保存，认证与 SSE 游标接续沿用客户端协议。

全局样式入口是 `src/styles/index.css`，颜色与尺寸统一来自 `tokens.css`。工作台和系统管理样式随页面加载；材质拥有自身背景和降级规则，避免异步样式覆盖。通用样式不包含功能页面的业务布局。

## 本地开发

- `pnpm webui:dev`：启动本地开发服务
- `pnpm --filter @synapse/runtime-webui build`：检查应用和 Vite 配置后构建
- `pnpm --filter @synapse/runtime-webui preview`：预览生产构建
- `pnpm --filter @synapse/runtime-webui typecheck`：检查浏览器代码与 Node 配置
- `pnpm --filter @synapse/runtime-webui test`：运行就近维护的单元测试

开发服务的 `/admin` 代理到 `http://127.0.0.1:3766`，可沿用已有 SSH 隧道。代理仅转换本地预览自身的 Origin；其他来源仍交给服务端校验。

浏览器集成测试属于仓库 `tools`，Playwright 由根工作区持有。运行 `pnpm test:webui`、`pnpm test:workspace`、`pnpm test:workspace-layout`、`pnpm test:workspace-refinements` 与 `pnpm test:webui-design`。材质示例只作为 `tools/fixtures/webui` 中的测试夹具，在专用测试进程中开启，不进入应用入口或生产构建。

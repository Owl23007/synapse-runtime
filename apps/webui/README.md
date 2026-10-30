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
config/                Vite 开发代理配置
```

`app` 装配页面，`features` 持有功能状态，`shared` 不依赖功能模块。工作台的 API 调用、分页游标、幂等键与切换隔离集中在功能 Hook；视图不新增 Runtime 领域规则。跨功能导航继续使用持久标识的 Hash 深链接。

页面通过 React `lazy` 分包，`Suspense` 与页面错误边界保留加载和重试入口。同一工作台的会话参数变化保留列表和折叠偏好。凭据仅在内存中保存，认证与 SSE 游标接续沿用客户端协议。

全局样式入口是 `src/styles/index.css`，颜色与尺寸统一来自 `tokens.css`。工作台和系统管理样式随页面加载；材质拥有自身背景和降级规则，避免异步样式覆盖。通用样式不包含功能页面的业务布局。

## 连接与存储

连接页按地址保存服务书签，支持新增、重命名、修改地址、删除和清空。成功认证后自动记录最近连接时间；失败认证不新增记录。首页显示最近五条，管理窗口最多保留二十条。

`localStorage` 的 `synapse.runtime.connections.v1` 只包含标准化的 HTTP/HTTPS 源地址、显示名称和最近成功连接时间。读写均按字段白名单校验，非法 URL、URL 凭据、路径、查询参数和片段不会恢复为连接。浏览器禁止存储或配额不足时退回页面内存并提示，仍可连接服务。书签按浏览器源隔离，不会自动同步到其他 Runtime。

Admin Token 只保存在输入状态和当前客户端内存中，不写入 `localStorage`、`sessionStorage`、IndexedDB 或 URL。侧栏设置下方展示当前连接与实时状态，退出会停止实时订阅并返回连接页，默认从页面内存回填同源令牌。切换地址清空输入令牌，刷新后需要重新输入。浏览器可读的存储及其同处保存密钥的加密封装都不能防御同源脚本窃取令牌，因而不提供跨刷新“记住令牌”。如需跨刷新免输令牌，应另行实现服务端短期会话和 `HttpOnly; Secure; SameSite` Cookie，而非持久化 Admin Token。参考 [OWASP HTML5 存储安全建议](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)。

认证请求仍仅发往当前页面源。选择其他服务时按钮变为“打开 Runtime”，跳转到目标管理页后再输入令牌，跳转不携带认证材料。非回环地址通过 HTTP 打开时禁止发送访问令牌，远程部署应使用 HTTPS 或本地 SSH 隧道。

## 本地开发

- `pnpm webui:dev`：启动本地开发服务
- `pnpm --filter @synapse/runtime-webui build`：检查应用和 Vite 配置后构建
- `pnpm --filter @synapse/runtime-webui preview`：预览生产构建
- `pnpm --filter @synapse/runtime-webui typecheck`：检查浏览器代码与 Node 配置
- `pnpm --filter @synapse/runtime-webui test`：运行就近维护的单元测试

开发服务的 `/admin` 代理到 `http://127.0.0.1:3766`，可沿用已有 SSH 隧道。代理仅转换本地预览自身的 Origin；其他来源仍交给服务端校验。

界面布局、文案和交互在本地手动验收，CI 不依赖浏览器。协议格式化、连接书签存储和其他纯逻辑通过就近维护的单元测试验证；仓库 `tools` 仅保留进程集成、容器隔离与工件生成等核心验收脚本。

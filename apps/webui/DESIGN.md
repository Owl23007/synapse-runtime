# WebUI 设计系统

`src/tokens.css` 是颜色、文字、间距、尺寸、圆角、阴影和动画的唯一来源。业务页面沿用现有 Runtime Client，不改变请求、认证、SSE、幂等键或 Commit/Ref 语义。

- L0：白色 Canvas，无装饰渐变
- L1：默认内容表面，白底、浅边框、极轻阴影
- L2：菜单与 Popover，78% 白色、18px 背景模糊
- L3：DAG 局部悬浮工具栏，边缘高光和悬停反馈；默认仍为 CSS 毛玻璃

`Surface` 提供 `standard`、`frosted`、`liquid` 三种材质。禁止在浮层内继续叠加透明材质，嵌套表面自动使用实体白底。内容区保持 L1。

顶部“外观”可选择普通玻璃、实验折射或实体表面。偏好仅在页面内存中保留，不占用凭据存储。实验分支使用 SVG 位移滤镜扭曲局部背景像素，属于折射近似，不是物理光学模拟；CSS 高光本身不产生折射。不引入持续渲染的 WebGL/WebGPU 循环，也不启用滤镜动画。不支持背景滤镜时回退为实体表面；SVG 背景滤镜的实际支持随浏览器而异，建议将实验项视为可选增强。

低性能设备可选“实体 · 低开销”。系统减少透明度偏好关闭模糊，减少动画或慢速刷新偏好关闭位移与动画。键盘支持跳到主要内容、标签方向键/Home/End、Popover Escape 与焦点返回，以及 DAG 的方向键平移和 Tab 节点选择。中文输入法组合期间不触发快捷发送。

Inter 400/500/600 随应用本地打包，中文使用系统字体，运行时不访问外部字体服务。

独立组件预览：运行 `pnpm webui:dev` 后打开 `/design-system.html`。此入口仅供开发和视觉验收，不进入生产导航或生产构建。预览使用真实基础组件，不依赖 Runtime 数据。

验证命令：`pnpm verify`、`pnpm test:webui`、`pnpm test:workspace`、`pnpm test:webui-design`。浏览器截图位于 `test-results/webui`、`test-results/workspace` 与 `test-results/design-system`。

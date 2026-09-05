import type { DefaultTheme } from "vitepress";

export const guideSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "用户指南",
    items: [
      { text: "快速开始", link: "/guide/getting-started" },
      { text: "运行链路", link: "/guide/runtime-flow" },
      { text: "配置", link: "/guide/configuration" },
      { text: "联网工具", link: "/guide/web-tools" },
      { text: "通道", link: "/guide/channels" },
      { text: "上下文与记忆", link: "/guide/context-memory" },
      { text: "Admin 与 CLI", link: "/guide/admin-cli" }
    ]
  }
];

export const developmentSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "架构与设计",
    items: [{ text: "架构说明", link: "/architecture" }]
  },
  {
    text: "技术参考",
    items: [
      { text: "包结构", link: "/reference/packages" },
      { text: "Adapter 能力矩阵", link: "/reference/adapter-capabilities" },
      { text: "闭环状态", link: "/reference/closure-status" },
      { text: "配置 Schema", link: "/reference/config" },
      { text: "命令", link: "/reference/commands" },
      { text: "安全", link: "/reference/security" },
      { text: "PRD 入口说明", link: "/reference/prds" }
    ]
  }
];

export const roadmapSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "产品规划",
    items: [
      { text: "状态看板", link: "/roadmap" },
      { text: "状态流程", link: "/roadmap#状态流程" },
      { text: "维护方式", link: "/roadmap#维护方式" },
      { text: "PRD 文档", link: "/prd/" }
    ]
  }
];

export const prdSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "PRD",
    items: [{ text: "文档目录", link: "/prd/" }]
  },
  {
    text: "模板",
    items: [
      { text: "编写规范", link: "/prd/templates/" },
      { text: "中文模板", link: "/prd/templates/template.cn" },
      { text: "英文模板", link: "/prd/templates/template.en" }
    ]
  },
  {
    text: "历史文档",
    items: [{ text: "归档说明", link: "/prd/archive/README" }]
  }
];

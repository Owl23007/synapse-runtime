import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Synapse Runtime",
  description: "Synapse Runtime 中文文档：通道、上下文、Agent、权限与运维。",
  lang: "zh-CN",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "首页", link: "/" },
      { text: "用户手册", link: "/guide/getting-started" },
      { text: "开发文档", link: "/architecture" },
      { text: "更新日志", link: "/changelog" },
      { text: "路线图", link: "/roadmap" },
      { text: "关于", link: "/about" }
    ],
    search: {
      provider: "local"
    },
    sidebar: {
      "/guide/": [
        {
          text: "用户手册",
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
      ],
      "/reference/": [
        {
          text: "开发文档",
          items: [
            { text: "包结构", link: "/reference/packages" },
            { text: "Harness 架构对照", link: "/monorepo-review" },
            { text: "命令", link: "/reference/commands" },
            { text: "配置 Schema", link: "/reference/config" },
            { text: "安全", link: "/reference/security" },
            { text: "PRDs", link: "/reference/prds" }
          ]
        }
      ],
      "/prd/": [
        {
          text: "PRD",
          items: [
            { text: "说明与格式", link: "/prd/" },
            { text: "路线图", link: "/roadmap" },
            { text: "归档", link: "/prd/archive/README" }
          ]
        }
      ],
      "/roadmap": [
        {
          text: "路线图",
          items: [
            { text: "状态看板", link: "/roadmap" },
            { text: "状态流程", link: "/roadmap#状态流程" },
            { text: "维护方式", link: "/roadmap#维护方式" },
            { text: "PRD 归档", link: "/prd/archive/README" }
          ]
        }
      ]
    },
    socialLinks: []
  }
});

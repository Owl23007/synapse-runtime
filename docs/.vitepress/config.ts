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
      { text: "指南", link: "/guide/getting-started" },
      { text: "参考", link: "/reference/packages" },
      { text: "PRD", link: "/reference/prds" }
    ],
    search: {
      provider: "local"
    },
    sidebar: [
      {
        text: "指南",
        items: [
          { text: "概览", link: "/" },
          { text: "快速开始", link: "/guide/getting-started" },
          { text: "运行链路", link: "/guide/runtime-flow" },
          { text: "配置", link: "/guide/configuration" },
          { text: "通道", link: "/guide/channels" },
          { text: "上下文与记忆", link: "/guide/context-memory" },
          { text: "Admin 与 CLI", link: "/guide/admin-cli" }
        ]
      },
      {
        text: "参考",
        items: [
          { text: "包结构", link: "/reference/packages" },
          { text: "命令", link: "/reference/commands" },
          { text: "配置 Schema", link: "/reference/config" },
          { text: "安全", link: "/reference/security" },
          { text: "PRDs", link: "/reference/prds" }
        ]
      }
    ],
    socialLinks: []
  }
});

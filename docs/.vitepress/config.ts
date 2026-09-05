import { defineConfig } from "vitepress";
import { developmentSidebar, guideSidebar, prdSidebar, roadmapSidebar } from "./sidebar";

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
      {
        text: "开发文档",
        items: [
          { text: "架构说明", link: "/architecture" },
          { text: "技术参考", link: "/reference/packages" }
        ]
      },
      {
        text: "产品规划",
        items: [
          { text: "路线图", link: "/roadmap" },
          { text: "PRD", link: "/prd/" }
        ]
      },
      { text: "更新日志", link: "/changelog" },
      { text: "关于", link: "/about" }
    ],
    search: {
      provider: "local"
    },
    sidebar: {
      "/guide/": guideSidebar,
      "/reference/": developmentSidebar,
      "/prd/": prdSidebar,
      "/roadmap": roadmapSidebar,
      "/architecture": developmentSidebar,
      "/napcat-docker": guideSidebar
    },
    socialLinks: []
  }
});

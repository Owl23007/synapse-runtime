import { defineConfig } from "vitepress";
import { prdSidebar, roadmapSidebar } from "./sidebar";

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
      { text: "Channel 契约", link: "/channel" },
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
      "/prd/": prdSidebar,
      "/roadmap": roadmapSidebar
    },
    socialLinks: []
  }
});

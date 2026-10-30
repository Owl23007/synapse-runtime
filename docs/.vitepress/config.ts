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
      { text: "资源与能力", link: "/reference/resources/overview" },
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
      "/reference/": [
        {
          text: "文件资源",
          items: [
            { text: "概览", link: "/reference/resources/overview" },
            { text: "资源与版本", link: "/reference/resources/assets" },
            { text: "QQ 文件", link: "/reference/resources/qq-files" },
            { text: "Native 上传", link: "/reference/resources/native-upload" },
            { text: "只读挂载", link: "/reference/resources/mounts" },
            { text: "English", link: "/reference/resources/overview.en" }
          ]
        },
        {
          text: "能力管理",
          items: [
            { text: "概览", link: "/reference/capabilities/overview" },
            { text: "Skills", link: "/reference/capabilities/skills" },
            { text: "MCP", link: "/reference/capabilities/mcp" },
            { text: "目录", link: "/reference/capabilities/registries" },
            { text: "更新与回滚", link: "/reference/capabilities/updates" },
            { text: "执行边界", link: "/reference/capabilities/execution-security" }
          ]
        },
        { text: "架构", link: "/reference/architecture/resource-capability-system" }
      ],
      "/prd/": prdSidebar,
      "/roadmap": roadmapSidebar
    },
    socialLinks: []
  }
});

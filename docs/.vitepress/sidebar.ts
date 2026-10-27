import type { DefaultTheme } from "vitepress";

/** 产品规划页面的有效导航入口 */
export const roadmapSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "产品规划",
    items: [
      { text: "状态看板", link: "/roadmap" },
      { text: "0.1 到 1.0", link: "/roadmap#从-0-1-到-1-0" },
      { text: "状态流程", link: "/roadmap#状态流程" },
      { text: "维护方式", link: "/roadmap#维护方式" },
      { text: "PRD 文档", link: "/prd/" }
    ]
  }
];

/** 当前保留的 PRD 目录、模板和归档导航 */
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

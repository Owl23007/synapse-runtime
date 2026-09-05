import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import PrdCatalog from "./components/prd/PrdCatalog.vue";
import PrdProgress from "./components/roadmap/PrdProgress.vue";
import "./styles.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("PrdCatalog", PrdCatalog);
    app.component("PrdProgress", PrdProgress);
  }
} satisfies Theme;

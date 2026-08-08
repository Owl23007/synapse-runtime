import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import PrdProgress from "./components/roadmap/PrdProgress.vue";
import "./styles.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("PrdProgress", PrdProgress);
  }
} satisfies Theme;

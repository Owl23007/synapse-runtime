import { type CSSProperties } from "react";

const paths = {
  workspace: "M3 3h7v7H3V3Z M14 3h7v7h-7V3Z M3 14h7v7H3v-7Z M14 14h7v7h-7v-7Z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  database:
    "M20 6c0 1.66-3.58 3-8 3S4 7.66 4 6s3.58-3 8-3 8 1.34 8 3Z M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6 M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3",
  chat: "M4 4h16v12H8l-4 4V4Z M8 8h8 M8 12h5",
  run: "M9 7l8 5-8 5V7Z M21 12a9 9 0 1 1-9-9",
  folder: "M3 6h7l2 2h9v12H3V6Z",
  plug: "M9 3v5 M15 3v5 M6 8h12 M7 8v4a5 5 0 0 0 10 0V8 M12 17v4",
  file: "M6 3h8l4 4v14H6V3Z M14 3v5h4 M9 12h6 M9 16h6",
  settings: "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  panel: "M3 4h18v16H3V4Z M15 4v16",
  sidebar: "M3 4h18v16H3V4Z M9 4v16",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l5 5",
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M6 18 18 6",
  branch:
    "M6 5v14 M6 12h7a5 5 0 0 0 5-5V5 M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M20 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  chevron: "m9 6 6 6-6 6",
  refresh: "M20 8a8 8 0 1 0 0 8 M20 3v6h-6",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  send: "m3 11 18-8-8 18-2-8-8-2Z M11 13 21 3",
  copy: "M8 8h12v13H8V8Z M16 8V3H3v13h5",
  check: "m5 12 4 4L19 6",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
  task: "M8 4H4v17h16V4h-4 M8 2h8v5H8V2Z M8 12l2 2 5-4 M8 18h8"
};

/** 按导航与动作命名描边图标，更多操作加粗圆点以保持小尺寸下可辨认 */
export function Icon({ name, style }: { name: keyof typeof paths; style?: CSSProperties }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3.2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** 使用矢量标记保持侧栏与对话头像在缩放时清晰 */
export function SynapseMark() {
  return (
    <svg className="synapse-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M13 2a4 4 0 0 1 6 0l5 6a4 4 0 0 1-1 6l-7 4-7-4a4 4 0 0 1-1-6Z" fill="currentColor" />
      <path d="m9 14 7 4-4 10a3 3 0 0 1-5 1l-5-5a3 3 0 0 1 0-5Z" fill="currentColor" opacity=".72" />
      <path d="m23 14-7 4 4 10a3 3 0 0 0 5 1l5-5a3 3 0 0 0 0-5Z" fill="currentColor" opacity=".42" />
    </svg>
  );
}

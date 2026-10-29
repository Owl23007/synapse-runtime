import { type KeyboardEvent } from "react";

/** 标签支持方向键与首尾跳转，操作按钮不参与标签循环 */
export function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLButtonElement) || event.target.role !== "tab") return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const index = tabs.indexOf(event.target);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (index - 1 + tabs.length) % tabs.length
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

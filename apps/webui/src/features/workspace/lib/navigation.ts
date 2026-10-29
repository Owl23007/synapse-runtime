/** 以持久会话与分支标识生成工作台深链接 */
export function navigate(id: string, line = "") {
  location.hash = `/workspace?session=${encodeURIComponent(id)}${line ? `&line=${encodeURIComponent(line)}` : ""}`;
}

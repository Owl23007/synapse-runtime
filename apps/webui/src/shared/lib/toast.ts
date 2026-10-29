/** 全局提醒的语义类型，文字与图标共同表达结果 */
export type ToastTone = "success" | "error" | "warning" | "info";

/** 提醒可单独调整停留时长，零表示保持至手动关闭 */
export interface ToastOptions {
  duration?: number;
}

/** 不持久化的提醒快照，标识用于隔离重复提醒的计时器 */
export interface ToastMessage {
  id: number;
  tone: ToastTone;
  text: string;
  duration: number;
}

/** 创建独立消息通道，最多显示三条并合并重复内容，避免连续操作遮挡工作区 */
export function createToastStore() {
  let messages: readonly ToastMessage[] = [];
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: readonly ToastMessage[]) => {
    messages = next;
    listeners.forEach((listener) => listener());
  };
  const show = (tone: ToastTone, text: string, options: ToastOptions = {}) => {
    if (!text.trim()) return undefined;
    const duration = options.duration ?? (tone === "error" ? 6000 : 3200);
    const item: ToastMessage = {
      id: ++sequence,
      tone,
      text,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : 3200
    };
    publish([...messages.filter((message) => message.tone !== tone || message.text !== text), item].slice(-3));
    return item.id;
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => messages,
    success: (text: string, options?: ToastOptions) => show("success", text, options),
    error: (text: string, options?: ToastOptions) => show("error", text, options),
    warning: (text: string, options?: ToastOptions) => show("warning", text, options),
    info: (text: string, options?: ToastOptions) => show("info", text, options),
    dismiss: (id: number) => publish(messages.filter((message) => message.id !== id)),
    clear: () => publish([])
  };
}

/** 应用级消息入口，与路由及连接状态解耦，切换页面时仍可看到操作结果 */
export const toast = createToastStore();

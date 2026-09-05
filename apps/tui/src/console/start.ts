import { render } from "ink";
import { createElement } from "react";
import { RuntimeConsoleController } from "./controller.js";
import type { RuntimeConsoleOptions } from "./types.js";
import { RuntimeConsoleApp } from "./ui.js";

/** 启动终端交互，并在退出或收到终止信号时回收所属进程 */
export async function startRuntimeConsole(options: RuntimeConsoleOptions): Promise<void> {
  const controller = new RuntimeConsoleController(options);
  const instance = render(createElement(RuntimeConsoleApp, { controller }));
  const terminate = () => {
    void controller.stop().finally(() => instance.unmount());
  };
  process.once("SIGTERM", terminate);
  try {
    await instance.waitUntilExit();
  } finally {
    process.off("SIGTERM", terminate);
    await controller.stop();
  }
}

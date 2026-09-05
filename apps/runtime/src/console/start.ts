import { render } from "ink";
import { createElement } from "react";
import { RuntimeConsoleController } from "./controller.js";
import type { RuntimeConsoleOptions } from "./types.js";
import { RuntimeConsoleApp } from "./ui.js";

export async function startRuntimeConsole(options: RuntimeConsoleOptions): Promise<void> {
  const controller = new RuntimeConsoleController(options);
  const instance = render(createElement(RuntimeConsoleApp, { controller }));
  await instance.waitUntilExit();
}

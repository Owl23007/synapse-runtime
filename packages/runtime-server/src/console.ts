export { RuntimeConsoleController } from "./console/controller.js";
export { addChannelConfigFile, updateChannelConfigFile } from "./console/config-editor.js";
export { ConsoleLogStore } from "./console/log-store.js";
export { toStructuredLog } from "./console/log-view-model.js";
export { startRuntimeConsole } from "./console/start.js";
export type {
  StructuredLogEntry,
  StructuredLogField,
  StructuredLogKind,
  StructuredLogStatus
} from "./console/log-view-model.js";
export type {
  ConsoleLevel,
  ConsoleLogEntry,
  ConsoleState,
  ConsoleStatus,
  ConsoleView,
  RuntimeConsoleOptions,
  StateListener
} from "./console/types.js";

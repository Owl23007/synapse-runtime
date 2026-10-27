// 保留既有工厂导入入口，完整组合与资源所有权由 Composition Root 管理
export {
  createRuntimeAssembly as createRuntimeFromConfig,
  type RuntimeFactoryOptions
} from "../composition/runtime-assembly.js";

/** 兼容既有工厂结果类型，新宿主使用 RuntimeAssembly 管理完整生命周期 */
export type RuntimeFactoryResult = Pick<
  import("../composition/runtime-assembly.js").RuntimeAssembly,
  "runtime" | "contextStore" | "tools" | "localeResolver"
>;

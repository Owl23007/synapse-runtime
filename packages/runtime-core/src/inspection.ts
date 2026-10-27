/** 共享追踪与日志的有界脱敏规则，不暴露运行时内部存储结构 */
export { redactTrace as redactInspection } from "./trace/redact.js";
export { RuntimeInspection, InspectionQueryError } from "./inspection/runtime-inspection.js";
export type { InspectionStore, ArtifactReader, InspectedArtifactContent } from "./inspection/runtime-inspection.js";

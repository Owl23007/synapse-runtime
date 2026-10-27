// 保留既有导入路径，文件持久实现位于 Infrastructure，业务规则位于 Core
export { ArtifactDeliveryStore, inspectArtifactDelivery } from "../infrastructure/artifact-delivery.js";
export type { ArtifactDeliveryKey } from "@synapse/runtime-core/artifacts";

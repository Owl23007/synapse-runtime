/** 工件交付应用用例与持久端口，不依赖 Docker 或具体工件存储 */
export {
  artifactDeliveryIdentity,
  resolveArtifactReceipt,
  recoverArtifactToolOutput,
  deliverArtifact,
  deliverGroupArtifact,
  canUploadGroupFile,
  requireGroupArtifactDestination,
  createArtifactDelivery,
  uploadSelectedArtifact
} from "./runtime/artifact-delivery.js";
export type {
  ArtifactDeliveryKey,
  ArtifactDeliveryRecord,
  ArtifactDeliveryReceipts,
  ArtifactDeliveryReader
} from "./runtime/artifact-delivery.js";

import { createErrorDescriptor, type ErrorDescriptor } from "@synapse/runtime-i18n";
/** 保留稳定机器描述并避免业务逻辑依赖展示文本的资源错误 */
export class ResourceError extends Error {
  readonly descriptor: ErrorDescriptor;

  /** 根据结构化描述创建资源错误 */
  constructor(descriptor: ErrorDescriptor) {
    super(descriptor.key);
    this.name = "ResourceError";
    this.descriptor = createErrorDescriptor(descriptor);
  }
}

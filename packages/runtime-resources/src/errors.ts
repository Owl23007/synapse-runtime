import { z } from "zod";

/** 可跨边界传递的结构化错误描述校验规则 */
export const ErrorDescriptorSchema = z.object({
  code: z.string().min(1),
  key: z.string().min(1),
  params: z.record(z.string()).optional(),
  cause: z.unknown().optional(),
  retryable: z.boolean().optional(),
  severity: z.enum(["info", "warning", "error", "fatal"]).optional(),
  expose: z.boolean().optional(),
  details: z.record(z.unknown()).optional()
});

/** 与展示语言无关的结构化错误描述 */
export type ErrorDescriptor = z.infer<typeof ErrorDescriptorSchema>;

/** 完成 Locale 解析后的用户可见错误 */
export type LocalizedError = ErrorDescriptor & { locale: string; message: string };

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

/** 校验并规范化结构化错误描述 */
export function createErrorDescriptor(input: ErrorDescriptor): ErrorDescriptor {
  return ErrorDescriptorSchema.parse(input);
}

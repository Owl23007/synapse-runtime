/** 模型提供商明确报告的失败分类，不将普通运行异常推断为可重试 */
export interface ModelFailure {
  readonly kind: "model";
  readonly code: "http" | "transport" | "timeout";
  readonly retryable: boolean;
}

/** 提供商边界的结构化错误，重试许可仍由执行内核结合持久副作用判断 */
export class ModelProviderError extends Error {
  /** 可持久化的模型失败分类，不包含提供商凭据 */
  readonly failure: ModelFailure;

  /** 标记本次模型请求的失败来源及是否属于暂时故障 */
  constructor(message: string, code: ModelFailure["code"], retryable: boolean) {
    super(message);
    this.name = "ModelProviderError";
    this.failure = { kind: "model", code, retryable };
  }
}

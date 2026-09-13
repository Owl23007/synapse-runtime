/** 当前上下文指针，版本号用于防止并发覆盖和 ABA 问题 */
export interface Ref {
  readonly scopeId: string;
  readonly name: string;
  readonly type: string;
  readonly commitId: string;
  readonly version: number;
}

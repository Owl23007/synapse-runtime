/** 设置表单使用的配置结构，由服务端领域校验规则生成 */
export interface ConfigFieldSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, ConfigFieldSchema>>;
  readonly additionalProperties?: boolean | ConfigFieldSchema;
  readonly propertyNames?: ConfigFieldSchema;
  readonly required?: readonly string[];
  readonly items?: ConfigFieldSchema;
  readonly anyOf?: readonly ConfigFieldSchema[];
  readonly oneOf?: readonly ConfigFieldSchema[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
}

/** 单项文件修改，路径以数组传递以保留带点号的权限名和映射键 */
export interface ConfigFileChange {
  readonly path: readonly string[];
  readonly value?: unknown;
  readonly remove?: boolean | undefined;
}

/** 可编辑的原始文件快照，敏感值不返回客户端 */
export interface ConfigEditorSnapshot {
  readonly ok: true;
  readonly revision: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly schema: ConfigFieldSchema;
  readonly secretPaths: readonly (readonly string[])[];
  readonly restartFields: readonly string[];
}

/** 保存只写入文件，由用户选择重载或重启以应用 */
export interface ConfigSaveResult {
  readonly ok: true;
  readonly reloadRequired: true;
  readonly restartFields: readonly string[];
}

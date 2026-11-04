import type { ConfigFieldSchema, ConfigFileChange } from "@synapse/runtime-client";

/** 配置分组名称与说明，同一表单覆盖全部领域配置 */
export const CONFIG_SECTIONS: Readonly<Record<string, readonly [string, string]>> = {
  runtime: ["运行与限额", "运行模式、数据目录、并发和超时"],
  agent: ["模型提供商", "添加模型连接并选择默认提供商"],
  channels: ["频道", "添加与编辑 OneBot 11、QQ 官方频道"],
  tools: ["工具", "网络搜索、网页访问与 Docker 执行"],
  conversation: ["会话触发", "私聊、群聊触发方式与历史策略"],
  context: ["上下文", "历史预算、时区与缓存策略"],
  agentLoop: ["Agent 循环", "步数、工具调用和模型输入输出预算"],
  autonomy: ["自主任务", "调度、重试、授权额度与保留期限"],
  permissions: ["权限", "为每项操作选择允许或拒绝策略"],
  server: ["业务服务", "监听地址、端口与公开 URL"],
  admin: ["管理服务", "管理入口、访问令牌与来源限制"],
  files: ["文件", "上传限额、文件挂载与资源管理"],
  container: ["容器", "容器运行环境与资源限制"],
  mcp: ["MCP 连接", "远程服务、目标白名单与响应预算"],
  capabilities: ["能力资源", "技能目录、更新与安装策略"],
  memory: ["记忆", "长期记忆与存储策略"],
  locale: ["语言", "默认语言与消息资源文件"],
  prompts: ["提示词", "提示词资源与默认用途"],
  presentation: ["表达方式", "表达模式与角色配置文件"]
};

const labels: Readonly<Record<string, string>> = {
  enabled: "启用",
  mode: "模式",
  type: "类型",
  default: "默认提供商",
  providers: "提供商",
  model: "模型名称",
  apiKey: "API 密钥",
  baseUrl: "服务地址",
  prefix: "前缀",
  headers: "请求头",
  extraBody: "附加请求参数",
  temperature: "温度",
  topP: "Top P",
  maxTokens: "最大 Token 数",
  maxOutputTokens: "最大输出 Token 数",
  dataDir: "数据目录",
  logLevel: "日志级别",
  limits: "运行限额",
  maxConcurrent: "最大并发数",
  maxQueued: "最大排队数",
  runTimeoutMs: "运行超时（毫秒）",
  toolTimeoutMs: "工具超时（毫秒）",
  shutdownGraceMs: "关闭等待（毫秒）",
  timeoutMs: "超时（毫秒）",
  host: "监听地址",
  port: "监听端口",
  publicBaseUrl: "公开访问地址",
  token: "访问令牌",
  allowedOrigins: "允许的页面来源",
  allowedRemoteAddresses: "允许的客户端地址",
  logBufferSize: "日志缓冲条数",
  adapter: "适配器",
  provider: "服务提供商",
  transport: "传输方式",
  endpoint: "连接地址",
  accessToken: "访问令牌",
  appId: "应用 ID",
  appSecret: "应用密钥",
  webhookPath: "Webhook 路径",
  riskLevel: "风险级别",
  apiBaseUrl: "API 地址",
  tokenEndpoint: "令牌接口",
  web: "网络工具",
  docker: "Docker 执行",
  search: "搜索引擎",
  allowedDomains: "允许的域名",
  deniedDomains: "拒绝的域名",
  allowPrivateNetwork: "允许访问私有网络",
  maxResponseBytes: "最大响应字节数",
  maxContentChars: "最大内容字符数",
  maxRedirects: "最大重定向次数",
  cacheTtlMs: "缓存有效期（毫秒）",
  userAgent: "User-Agent",
  image: "镜像",
  memoryMb: "内存（MB）",
  cpus: "CPU 核数",
  maxArtifactBytes: "最大产物字节数",
  maxSteps: "最大步数",
  maxToolCalls: "最大工具调用数",
  maxInputChars: "最大输入字符数",
  maxRequestChars: "最大请求字符数",
  timezone: "时区",
  strategy: "策略",
  cache: "缓存",
  maxHistoryChars: "最大历史字符数",
  maxTotalChars: "最大上下文字符数",
  privateHistoryTtlMinutes: "私聊历史有效期（分钟）",
  groupHistoryTtlMinutes: "群聊历史有效期（分钟）",
  channelHistoryTtlMinutes: "频道历史有效期（分钟）",
  privateMaxMessages: "私聊最大消息数",
  groupMaxMessages: "群聊最大消息数",
  channelMaxMessages: "频道最大消息数",
  privateTrigger: "私聊触发",
  groupTrigger: "群聊触发",
  keywords: "关键词",
  commandPrefixes: "命令前缀",
  botUserIds: "机器人用户 ID",
  allowCommandWithoutMention: "允许未提及机器人的命令",
  contextPolicy: "上下文策略",
  includeHistory: "包含历史消息",
  maxMessages: "最大消息数",
  catalogPath: "资源文件路径",
  defaultPurpose: "默认用途",
  profilePath: "表达配置路径",
  defaultProfileId: "默认表达配置",
  servers: "服务列表",
  id: "标识",
  url: "URL",
  authTokenEnv: "凭据环境变量名",
  allowedHosts: "允许的主机",
  privateHosts: "私有主机",
  mounts: "文件挂载",
  root: "根目录",
  urlPrefix: "访问路径前缀",
  maxNativeUploadBytes: "原生上传上限（字节）",
  skillsDirectory: "技能目录",
  pollIntervalMs: "轮询间隔（毫秒）",
  maxPendingIntents: "最大待处理意图数",
  maxAttempts: "最大尝试次数",
  retryBaseDelayMs: "重试初始间隔（毫秒）",
  maxRetryDelayMs: "最大重试间隔（毫秒）",
  maxRunsPerHour: "每小时最大运行数",
  maxRunsPerGrant: "每次授权最大运行数",
  maxModelCallsPerRun: "每轮最大模型调用数",
  maxToolCallsPerRun: "每轮最大工具调用数",
  maxTasks: "最大任务数",
  maxTaskDepth: "最大任务深度",
  maxSchedules: "最大调度数",
  maxScheduleOccurrences: "最大调度次数",
  maxScheduleLifetimeHours: "最大调度时长（小时）",
  minScheduleIntervalMs: "最小调度间隔（毫秒）",
  maxContextCommits: "最大上下文提交数",
  maxRecordChars: "最大记录字符数",
  retentionHours: "保留期限（小时）",
  observationTtlMinutes: "观察有效期（分钟）",
  maxObservationsPerSession: "每会话最大观察数",
  maxDatabaseBytes: "最大数据库字节数"
};

/** 中文字段标题保留配置键作为定位依据 */
export function configLabel(key: string): string {
  return labels[key] ?? CONFIG_SECTIONS[key]?.[0] ?? key;
}

/** 按当前判别字段选择模型、频道和搜索引擎对应的表单 */
export function configVariant(schema: ConfigFieldSchema, value: unknown): ConfigFieldSchema {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) return schema;
  const record = objectValue(value);
  return (
    variants.find((variant) =>
      Object.entries(variant.properties ?? {}).some(
        ([key, field]) => field.const !== undefined && record[key] === field.const
      )
    ) ??
    variants.find((variant) => variant.type !== "null") ??
    schema
  );
}

/** 新增配置时只创建必填项，默认值继续由服务端领域规则提供 */
export function initialConfigValue(input: ConfigFieldSchema): unknown {
  const schema = configVariant(input, undefined);
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key, field]) => schema.required?.includes(key) || field.const !== undefined)
        .map(([key, field]) => [key, initialConfigValue(field)])
    );
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number")
    return schema.minimum ?? (schema.exclusiveMinimum === undefined ? 0 : schema.exclusiveMinimum + 1);
  return "";
}

/** 修改草稿使用与服务端相同的顺序操作，删除数组项后仍保持密钥与所属连接对应 */
export function changeConfigDraft(
  config: Readonly<Record<string, unknown>>,
  change: ConfigFileChange
): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(config);
  let target = next;
  for (const key of change.path.slice(0, -1)) {
    if (!Object.hasOwn(target, key)) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  const key = change.path.at(-1)!;
  if (Array.isArray(target) && change.remove) target.splice(Number(key), 1);
  else if (change.remove) delete target[key];
  else target[key] = change.value;
  return next;
}

/** 将可选对象转换成表单可遍历的键值集合 */
export function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

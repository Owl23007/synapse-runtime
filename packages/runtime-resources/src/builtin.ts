import type { LocaleCatalog } from "./locale.js";

/** Runtime 首批内置中文错误资源，外部 Catalog 可按 Key 覆盖 */
export const zhCNCoreErrorCatalog: LocaleCatalog = {
  locale: "zh-CN",
  messages: {
    "agent.request_timeout": "模型请求超时，请稍后重试。",
    "agent.request_failed": "模型请求失败，请稍后重试。",
    "agent.stream_failed": "模型流式响应中断，请稍后重试。",
    "agent.provider_unavailable": "模型服务当前不可用，请稍后重试。",
    "runtime.internal_error": "运行时发生内部错误，请稍后重试。",
    "runtime.configuration_invalid": "运行时配置无效：{reason}。",
    "tool.execution_failed": "工具执行失败：{tool}。",
    "tool.not_found": "未找到工具：{tool}。",
    "permission.denied": "没有执行此操作的权限。",
    "conversation.not_found": "未找到对应的会话。",
    "admin.branch_not_found": "未找到对应的分支。",
    "admin.task_not_found": "未找到对应的任务。",
    "admin.missing_task_id": "缺少任务标识。",
    "admin.task_cancel_failed": "取消任务失败，请稍后重试。",
    "admin.missing_channel_id": "缺少 Channel 标识。",
    "admin.channel_not_found": "未找到对应的 Channel。",
    "admin.invalid_channel_patch": "Channel 更新参数无效。",
    "admin.channel_patch_failed": "更新 Channel 失败，请稍后重试。",
    "admin.reload_config_path_not_available": "当前无法获取配置文件路径。",
    "admin.reload_failed": "重新加载配置失败，请检查配置后重试。",
    "config.invalid": "配置无效：{reason}。",
    "context.compose_failed": "上下文合成失败，请稍后重试。",
    "prompt.duplicate": "提示词配置重复：{id}。",
    "prompt.not_found": "未找到提示词配置：{id}。",
    "prompt.disabled": "提示词配置未启用：{id}。",
    "prompt.variables_missing": "提示词配置缺少变量：{variables}。"
  }
};

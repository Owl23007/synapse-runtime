import type { CapabilityBinding, CapabilityInfo, CatalogItem } from "@synapse/runtime-client";

/** 目录按来源与包身份匹配安装版本，启用状态只认工作区绑定的具体安装 */
export function catalogItemState(
  item: CatalogItem,
  installations: readonly CapabilityInfo[],
  bindings: readonly CapabilityBinding[]
): "enabled" | "installed" | "uninstalled" {
  const matches = installations.filter(
    (installation) => installation.packageKey === `${item.provider}:${item.packageId}`
  );
  if (
    matches.some((installation) =>
      bindings.some(
        (binding) =>
          binding.enabled && binding.installId === installation.id && binding.packageKey === installation.packageKey
      )
    )
  )
    return "enabled";
  return matches.length ? "installed" : "uninstalled";
}

/** 仅用明确错误码诊断配置缺失，普通 403 保持为访问权限问题 */
export function capabilityIssue(error: string) {
  if (error.includes("mcp_host_requires_configuration"))
    return {
      title: "MCP 服务需要配置",
      reason: "所选服务的目标主机尚未加入 MCP 允许列表，请在 MCP 连接中配置允许的主机后重试",
      section: "mcp"
    };
  if (error.includes("mcp_auth_environment_missing"))
    return {
      title: "MCP 服务缺少凭据",
      reason: "服务声明的凭据环境变量尚未设置，请检查 MCP 连接配置及 Runtime 运行环境",
      section: "mcp"
    };
  if (error.includes("mcp_config_disabled"))
    return { title: "MCP 连接已停用", reason: "请先在 MCP 连接配置中确认并启用此服务，再重新连接", section: "mcp" };
  if (error.includes("catalog_not_found"))
    return { title: "此能力目录尚未启用", reason: "请检查能力资源中的目录配置，再重新搜索", section: "capabilities" };
  if (error.includes("capability_source_not_allowed") || error.includes("github_handoff_not_allowed"))
    return {
      title: "安装来源未获允许",
      reason: "请在能力资源配置中检查允许的安装来源，再重试安装",
      section: "capabilities"
    };
  if (/HTTP (401|403)/.test(error))
    return { title: "访问权限不足", reason: "请检查当前 Admin Token 及管理服务访问权限，确认后重试", section: "admin" };
  return {
    title: "",
    reason: "请检查 Runtime、网络及来源服务的状态后重试；原始错误可在详情中查看",
    section: "capabilities"
  };
}

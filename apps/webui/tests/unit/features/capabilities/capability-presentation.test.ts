import { describe, expect, it } from "vitest";
import type { CapabilityBinding, CapabilityInfo, CatalogItem } from "@synapse/runtime-client";
import { capabilityIssue, catalogItemState } from "../../../../src/features/capabilities/capability-presentation.js";

const item: CatalogItem = { provider: "clawhub", packageId: "github", name: "GitHub", description: "GitHub Skill" };
function installation(id: string, packageKey = "clawhub:github"): CapabilityInfo {
  return {
    id,
    kind: "skill",
    packageKey,
    source: {},
    sourceVersion: id,
    sourceRevision: null,
    contentDigest: id,
    metadata: {},
    state: "installed",
    installedAt: "2026-11-04T00:00:00Z"
  };
}
function binding(installId: string, enabled = true, packageKey = "clawhub:github"): CapabilityBinding {
  return { workspaceId: "workspace", packageKey, installId, enabled, settings: {} };
}

describe("目录安装与启用状态", () => {
  it("同名包不会跨来源误认为已安装", () => {
    expect(catalogItemState(item, [installation("v1", "github:github")], [])).toBe("uninstalled");
    expect(catalogItemState(item, [installation("v1")], [])).toBe("installed");
  });

  it("启用状态必须匹配包身份、安装版本和工作区启用标记", () => {
    const versions = [installation("v1"), installation("v2")];
    expect(catalogItemState(item, versions, [binding("v1")])).toBe("enabled");
    expect(catalogItemState(item, versions, [binding("v1", false)])).toBe("installed");
    expect(catalogItemState(item, versions, [binding("missing")])).toBe("installed");
    expect(catalogItemState(item, versions, [binding("v1", true, "clawhub:other")])).toBe("installed");
  });
});

describe("可恢复的能力状态诊断", () => {
  it("普通 403 仅提示访问权限，不推断 MCP Host 未配置", () => {
    const issue = capabilityIssue('Admin API 请求失败（HTTP 403）: {"ok":false,"error":"forbidden"}');
    expect(issue).toMatchObject({ title: "访问权限不足", section: "admin" });
    expect(issue.reason).not.toContain("允许列表");
  });

  it("仅明确的主机配置错误定位到 MCP 分类", () => {
    expect(
      capabilityIssue('Admin API 请求失败（HTTP 403）: {"error":"mcp_host_requires_configuration"}')
    ).toMatchObject({ title: "MCP 服务需要配置", section: "mcp" });
    expect(capabilityIssue("mcp_auth_environment_missing")).toMatchObject({ section: "mcp" });
  });

  it("目录未启用与安装来源受限定位到能力资源分类", () => {
    expect(capabilityIssue('Admin API 请求失败（HTTP 404）: {"error":"catalog_not_found"}')).toMatchObject({
      title: "此能力目录尚未启用",
      section: "capabilities"
    });
    expect(capabilityIssue('Admin API 请求失败（HTTP 403）: {"error":"capability_source_not_allowed"}')).toMatchObject({
      title: "安装来源未获允许",
      section: "capabilities"
    });
  });

  it("网络错误保留调用方上下文，不伪造缺失配置", () => {
    expect(capabilityIssue("无法连接 Runtime")).toMatchObject({ title: "", section: "capabilities" });
  });
});

import type { AgentRequest } from "@synapse/runtime-conversation";
import type { ChannelRegistry } from "@synapse/runtime-channel";
import type { Tool, ToolRuntime } from "@synapse/runtime-tool-runtime";
import { canUploadGroupFile } from "./channel-delivery.js";

/** 一次调用中工具注册、授权及编译过滤的管理员审计 */
export interface ToolVisibilityAudit {
  readonly runId: string;
  readonly registeredTools: readonly string[];
  readonly availableTools: readonly string[];
  readonly allowedTools: readonly string[];
  readonly exposedTools: readonly string[];
  readonly rejected: readonly {
    readonly name: string;
    readonly stage: "availability" | "permission" | "compilation";
    readonly reason: string;
  }[];
}

/** 使用可信请求筛选工具，动态参数权限仍在实际调用时检查 */
export async function resolveVisibleTools(
  request: AgentRequest,
  tools: ToolRuntime,
  channels: ChannelRegistry
): Promise<{ tools: readonly Tool[]; audit: ToolVisibilityAudit }> {
  const inspected = tools.inspectForContext({
    runId: request.runId ?? "",
    sessionId: request.sessionId,
    userId: request.userId,
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {})
  });
  const decisions = await Promise.all(
    inspected.map(async ({ tool, available, reason }) => {
      if (!available) return { tool, stage: "availability" as const, reason: reason! };
      if (
        ((tool.name === "container.run" && request.source.platform !== "native") || tool.name === "artifact.upload") &&
        (request.source.conversationKind !== "group" || !canUploadGroupFile(channels.get(request.source.channelId)))
      )
        return { tool, stage: "availability" as const, reason: "file_delivery_unavailable" };
      if (typeof tool.permission === "function") return { tool };
      const decision = await tools.decidePermission({ ...tool.permission, subject: request.userId });
      return decision.decision === "allow"
        ? { tool }
        : {
            tool,
            stage: "permission" as const,
            reason: decision.reason ?? `permission_${decision.decision}:${tool.permission.action}`
          };
    })
  );
  const visible = decisions.filter((item) => !item.stage).map(({ tool }) => tool);
  return {
    tools: visible,
    audit: {
      runId: request.runId ?? "",
      registeredTools: inspected.map(({ tool }) => tool.name),
      availableTools: decisions.filter((item) => item.stage !== "availability").map(({ tool }) => tool.name),
      allowedTools: visible.map((tool) => tool.name),
      exposedTools: visible.map((tool) => tool.name),
      rejected: decisions.flatMap(({ tool, stage, reason }) =>
        stage ? [{ name: tool.name, stage, reason: reason! }] : []
      )
    }
  };
}

/** 将 Skill 等编译约束的工具收窄补充到审计中，不改变权限判断 */
export function completeToolVisibilityAudit(
  audit: ToolVisibilityAudit,
  exposed: readonly string[]
): ToolVisibilityAudit {
  const names = new Set(exposed);
  return {
    ...audit,
    exposedTools: [...exposed],
    rejected: [
      ...audit.rejected,
      ...audit.allowedTools
        .filter((name) => !names.has(name))
        .map((name) => ({
          name,
          stage: "compilation" as const,
          reason: "compiler_tool_restriction"
        }))
    ]
  };
}

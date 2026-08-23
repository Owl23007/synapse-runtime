import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { ConversationStore } from "../conversation/index.js";
import type { RuntimeActor, WorkspaceRef } from "../context/types.js";
import type { WorkspaceStore } from "../context/workspace.js";
import type { MemoryStore } from "../memory/types.js";

interface CommandContext {
  readonly text: string;
  readonly actor: RuntimeActor;
  readonly workspace: WorkspaceRef;
  readonly sessionId: string;
  readonly conversationStore: ConversationStore;
  readonly options: {
    readonly enableDurableMemory?: boolean;
    readonly memoryStore?: MemoryStore;
    readonly workspaceStore?: WorkspaceStore;
    readonly sourceEventId?: string;
  };
}

interface CommandDefinition {
  readonly usage: string;
  readonly description: string;
  matches(text: string): boolean;
  execute(context: CommandContext): SynapseMessage | undefined | Promise<SynapseMessage | undefined>;
}

const commands: readonly CommandDefinition[] = [
  {
    usage: "/help",
    description: "查看所有可用指令",
    matches: (text) => text === "/help",
    execute: () =>
      textResponse(["可用指令：", ...commands.map(({ usage, description }) => `${usage} - ${description}`)].join("\n"))
  },
  {
    usage: "/whoami",
    description: "查看当前身份",
    matches: (text) => text === "/whoami",
    execute: ({ actor }) =>
      textResponse(
        [
          `platform=${actor.platformIdentity.platform}`,
          `provider=${actor.platformIdentity.provider}`,
          `channelId=${actor.platformIdentity.channelId}`,
          `platformUserId=${actor.platformIdentity.platformUserId}`,
          `identityId=${actor.identity.id}`,
          `identityType=${actor.identity.type}`
        ].join("\n")
      )
  },
  {
    usage: "/workspace info",
    description: "查看当前工作区",
    matches: (text) => text === "/workspace info",
    execute: ({ workspace }) =>
      textResponse(`workspaceId=${workspace.id}\nworkspaceType=${workspace.type}\nworkspaceName=${workspace.name}`)
  },
  {
    usage: "/workspace use project:<id>",
    description: "切换到项目工作区",
    matches: (text) => text.startsWith("/workspace use project:"),
    execute: async ({ text, actor, workspace, options }) => {
      if (workspace.type === "group") return textResponse("群聊中不能切换项目工作区，请在私聊中执行该命令。");
      const workspaceStore = options.workspaceStore;
      if (workspaceStore?.bindProjectWorkspace === undefined) {
        return textResponse("当前运行时未启用项目工作区存储。");
      }
      const projectId = text.slice("/workspace use project:".length).trim();
      if (!projectId) return textResponse("用法：/workspace use project:<id>");
      const project = await workspaceStore.bindProjectWorkspace({
        workspaceId: projectId,
        identityId: actor.identity.id
      });
      return textResponse(`已切换到项目工作区：${project.name}（${project.id}）`);
    }
  },
  {
    usage: "/branches",
    description: "查看当前会话分支",
    matches: (text) => text === "/branches",
    execute: async ({ conversationStore, sessionId }) => {
      const branches = await conversationStore.listBranches(sessionId);
      return textResponse(
        branches.length === 0
          ? "当前会话没有分支。"
          : ["分支：", ...branches.map((branch) => `- ${branch.id} [${branch.status}] ${branch.title}`)].join("\n")
      );
    }
  },
  {
    usage: "/tasks",
    description: "查看当前会话任务",
    matches: (text) => text === "/tasks",
    execute: async ({ conversationStore, sessionId }) => {
      const branches = await conversationStore.listBranches(sessionId);
      const tasks = (await Promise.all(branches.map((branch) => conversationStore.listTasks(branch.id)))).flat();
      return textResponse(
        tasks.length === 0
          ? "当前会话没有任务。"
          : ["任务：", ...tasks.map((task) => `- ${task.id} [${task.status}] executor=${task.executor}`)].join("\n")
      );
    }
  },
  {
    usage: "/memory <remember|list|delete>",
    description: "管理长期记忆",
    matches: isMemoryCommand,
    execute: async ({ text, actor, workspace, options }) => {
      if (options.enableDurableMemory !== true || options.memoryStore === undefined) {
        return textResponse("当前未启用长期记忆。你的消息只会作为当前会话历史使用。");
      }
      return executeMemoryCommand(text, actor, workspace, options.memoryStore, options.sourceEventId);
    }
  }
];

/**
 * 根据频道事件生成内置命令响应
 */
export async function commandResponse(
  event: SynapseChannelEvent,
  actor: RuntimeActor,
  workspace: WorkspaceRef,
  sessionId: string,
  conversationStore: ConversationStore,
  options: {
    readonly enableDurableMemory?: boolean;
    readonly memoryStore?: MemoryStore;
    readonly workspaceStore?: WorkspaceStore;
    readonly sourceEventId?: string;
  } = {}
): Promise<SynapseMessage | undefined> {
  const text = event.message === undefined ? "" : getTextContent(event.message).trim();
  const command = commands.find((candidate) => candidate.matches(text));
  return command?.execute({ text, actor, workspace, sessionId, conversationStore, options });
}

function isMemoryCommand(text: string): boolean {
  return (
    text === "/memory" ||
    text.startsWith("/memory ") ||
    text === "/memory remember" ||
    text.startsWith("/memory remember ") ||
    text === "/memory list" ||
    text.startsWith("/memory list ") ||
    text === "/memory delete" ||
    text.startsWith("/memory delete ")
  );
}

async function executeMemoryCommand(
  text: string,
  actor: RuntimeActor,
  workspace: WorkspaceRef,
  store: MemoryStore,
  sourceEventId?: string
): Promise<SynapseMessage> {
  const parts = text.trim().split(/\s+/);
  const action = parts[1];
  if (action === undefined || action === "list") {
    const records = await store.list({
      identityId: actor.identity.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      limit: 50
    });
    return textResponse(
      records.length === 0
        ? "当前没有可用的长期记忆。"
        : [
            "长期记忆：",
            ...records.map((record) => `- ${record.id} [${memoryScopeLabel(record)}] ${record.content}`)
          ].join("\n")
    );
  }

  if (action === "search") {
    const query = parts.slice(2).join(" ").trim();
    if (!query) return textResponse("用法：/memory search 关键词");
    const results =
      store.search === undefined
        ? (
            await store.list({
              identityId: actor.identity.id,
              workspaceId: workspace.id,
              workspaceType: workspace.type,
              limit: 50
            })
          )
            .filter((record) => record.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .map((record) => ({ record, score: 1 }))
        : await store.search({
            query,
            identityId: actor.identity.id,
            workspaceId: workspace.id,
            workspaceType: workspace.type,
            limit: 20
          });
    return textResponse(
      results.length === 0
        ? "没有匹配的长期记忆。"
        : ["匹配的长期记忆：", ...results.map(({ record }) => `- ${record.id} ${record.content}`)].join("\n")
    );
  }

  if (action === "remember") {
    const requestedScope =
      parts[2] === "private" || parts[2] === "group" || parts[2] === "workspace" ? parts[2] : undefined;
    const content = parts
      .slice(requestedScope === undefined ? 2 : 3)
      .join(" ")
      .trim();
    if (!content) return textResponse("用法：/memory remember [private|group] 内容");
    const identityScope = requestedScope === "private" || (requestedScope === undefined && workspace.type !== "group");
    if (requestedScope === "private" && workspace.type === "group") {
      return textResponse("群聊中不能写入私人记忆，请在私聊中执行该命令。");
    }
    const scopeId = identityScope ? actor.identity.id : workspace.id;
    await store.remember({
      scopeType: identityScope ? "identity" : "workspace",
      scopeId,
      ...(identityScope ? { identityId: actor.identity.id } : { workspaceId: workspace.id }),
      visibility: identityScope ? "private" : "workspace",
      kind: "preference",
      content,
      source: "command:/memory remember",
      ...(sourceEventId === undefined ? {} : { sourceEventId }),
      idempotencyKey: `command:memory:${sourceEventId ?? `${actor.identity.id}:${content}`}`
    });
    return textResponse(
      identityScope
        ? "已记住为你的私人偏好。"
        : workspace.type === "project"
          ? "已记住为项目设置。"
          : "已记住为本群设置。"
    );
  }

  if (action === "delete" && parts[2] !== undefined) {
    const deleted = await store.delete(parts[2], {
      identityId: actor.identity.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      idempotencyKey: `command:memory-delete:${sourceEventId ?? parts[2]}`
    });
    return textResponse(deleted ? "已删除该长期记忆。" : "未找到可删除的长期记忆。");
  }

  return textResponse(
    "用法：/memory remember [private|group] 内容\n/memory list\n/memory search 关键词\n/memory delete <id>"
  );
}

function memoryScopeLabel(record: { readonly scopeType: string; readonly visibility: string }): string {
  return record.scopeType === "identity" || record.visibility === "private" ? "private" : "workspace";
}

function textResponse(text: string): SynapseMessage {
  return { type: "text", segments: [{ type: "text", text }] };
}

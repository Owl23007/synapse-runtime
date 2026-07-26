import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { RuntimeActor, WorkspaceRef } from "../context/types.js";

interface CommandContext {
  readonly actor: RuntimeActor;
  readonly workspace: WorkspaceRef;
  readonly options: { readonly enableDurableMemory?: boolean };
}

interface CommandDefinition {
  readonly usage: string;
  readonly description: string;
  matches(text: string): boolean;
  execute(context: CommandContext): SynapseMessage | undefined;
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
    execute: () => textResponse("Project workspace is not supported in P0.")
  },
  {
    usage: "/memory <remember|list|delete>",
    description: "管理长期记忆",
    matches: isMemoryCommand,
    execute: ({ options }) =>
      options.enableDurableMemory === true
        ? undefined
        : textResponse("当前未启用长期记忆。你的消息只会作为当前会话历史使用。")
  }
];

export function commandResponse(
  event: SynapseChannelEvent,
  actor: RuntimeActor,
  workspace: WorkspaceRef,
  options: { readonly enableDurableMemory?: boolean } = {}
): SynapseMessage | undefined {
  const text = event.message === undefined ? "" : getTextContent(event.message).trim();
  const command = commands.find((candidate) => candidate.matches(text));
  return command?.execute({ actor, workspace, options });
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

function textResponse(text: string): SynapseMessage {
  return { type: "text", segments: [{ type: "text", text }] };
}

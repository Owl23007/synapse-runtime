import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { RuntimeActor, WorkspaceRef } from "../context/types.js";

export function commandResponse(
  event: SynapseChannelEvent,
  actor: RuntimeActor,
  workspace: WorkspaceRef,
  options: { readonly enableDurableMemory?: boolean } = {}
): SynapseMessage | undefined {
  const text = event.message === undefined ? "" : getTextContent(event.message).trim();

  if (text === "/whoami") {
    return {
      type: "text",
      segments: [
        {
          type: "text",
          text: [
            `platform=${actor.platformIdentity.platform}`,
            `provider=${actor.platformIdentity.provider}`,
            `channelId=${actor.platformIdentity.channelId}`,
            `platformUserId=${actor.platformIdentity.platformUserId}`,
            `identityId=${actor.identity.id}`,
            `identityType=${actor.identity.type}`
          ].join("\n")
        }
      ]
    };
  }

  if (text === "/workspace info") {
    return {
      type: "text",
      segments: [
        {
          type: "text",
          text: `workspaceId=${workspace.id}\nworkspaceType=${workspace.type}\nworkspaceName=${workspace.name}`
        }
      ]
    };
  }

  if (text.startsWith("/workspace use project:")) {
    return { type: "text", segments: [{ type: "text", text: "Project workspace is not supported in P0." }] };
  }

  if (isMemoryCommand(text) && options.enableDurableMemory !== true) {
    return {
      type: "text",
      segments: [{ type: "text", text: "当前未启用长期记忆。你的消息只会作为当前会话历史使用。" }]
    };
  }

  return undefined;
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

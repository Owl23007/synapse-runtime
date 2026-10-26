import { readToolOutput, type MessageSegment, type SynapseMessage } from "@synapse/runtime-protocol";
import type { ArtifactStore } from "@synapse/runtime-tool-container";
import type { Tool } from "@synapse/runtime-tool-runtime";

/** 将旧 Docker 传输结果在工具观察前存入统一工件库，业务事件只携带引用 */
export function persistDockerArtifacts(tool: Tool, artifacts: ArtifactStore): Tool {
  return {
    ...tool,
    async handle(input, context) {
      const raw = await tool.handle(input, context);
      const output = readToolOutput(raw);
      if (output === undefined) throw new Error("Docker 工具结果无效");
      context.signal?.throwIfAborted();
      if (output.attachments.length === 0) return raw;
      if (context.callId === undefined) throw new Error("Docker 工件缺少持久调用标识");
      const files = output.attachments.map((part) => {
        if ((part.type !== "file" && part.type !== "image") || !part.url?.startsWith("base64://"))
          throw new Error("Docker 工件传输无效");
        const encoded = part.url.slice(9);
        const data = Buffer.from(encoded, "base64");
        if (data.toString("base64") !== encoded) throw new Error("Docker 工件编码无效");
        return { name: part.type === "file" ? part.name : (part.alt ?? "image.png"), data };
      });
      const saved = artifacts.save(
        { sessionId: context.sessionId, runId: context.runId, callId: context.callId },
        files
      );
      return {
        schemaVersion: "runtime-tool-output/v1",
        modelOutput: { ...(output.modelOutput as Record<string, unknown>), status: "generated", artifacts: saved },
        attachments: saved.map((artifact, index) => {
          const original = output.attachments[index]!;
          return { ...original, url: `artifact://${artifact.id}` };
        })
      };
    }
  };
}

/** 仅在适配器发送边界还原内容，持久回复和 DAG 保留稳定工件引用 */
export function materializeArtifactMessage(
  artifacts: ArtifactStore,
  sessionId: string,
  message: SynapseMessage
): SynapseMessage {
  const segments: MessageSegment[] = message.segments.map((part) => {
    if ((part.type !== "file" && part.type !== "image") || !part.url?.startsWith("artifact://")) return part;
    const artifact = artifacts.read(sessionId, part.url.slice(11));
    return { ...part, url: `base64://${Buffer.from(artifact.data).toString("base64")}` };
  });
  return { ...message, segments };
}

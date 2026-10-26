import { readToolOutput, type MessageSegment, type SynapseMessage } from "@synapse/runtime-protocol";
import type { ArtifactStore } from "@synapse/runtime-tool-container";
import type { Tool } from "@synapse/runtime-tool-runtime";
import { z } from "zod";
import type { ChannelRegistry } from "@synapse/runtime-channel";
import type { RuntimeCoreOptions } from "@synapse/runtime-core";
import type { ArtifactDeliveryStore } from "./artifact-delivery.js";

const selectionInput = z.object({
  selectArtifactIds: z.array(z.string().uuid()).max(16).optional(),
  discardArtifactIds: z.array(z.string().uuid()).max(16).optional()
});

/** 将旧 Docker 传输结果在工具观察前存入统一工件库，业务事件只携带引用 */
export function persistDockerArtifacts(tool: Tool, artifacts: ArtifactStore): Tool {
  return {
    ...tool,
    description: `${tool.description} 工件已统一持久化，返回 artifact ID。可用 selectArtifactIds 指定本轮最终产物、discardArtifactIds 废弃草稿；仅管理已有工件时无需 command。同名修订版默认替换旧版，只有最终选中文件会随回复交付。`,
    inputSchema: {
      ...tool.inputSchema,
      required: [],
      anyOf: [{ required: ["command"] }, { required: ["selectArtifactIds"] }, { required: ["discardArtifactIds"] }],
      properties: {
        ...(tool.inputSchema?.properties as Record<string, unknown>),
        ...z.toJSONSchema(selectionInput).properties
      }
    },
    async handle(input, context) {
      const management = selectionInput.parse(input);
      const {
        selectArtifactIds: _selected,
        discardArtifactIds: _discarded,
        ...execution
      } = input as Record<string, unknown>;
      context.signal?.throwIfAborted();
      // 管理请求不得忽略拼错的执行参数，只有这两种字段可以省略命令
      const onlyManagement =
        Object.keys(execution).length === 0 &&
        (management.selectArtifactIds !== undefined || management.discardArtifactIds !== undefined);
      if (management.selectArtifactIds !== undefined && management.discardArtifactIds !== undefined)
        throw new Error("最终选择与废弃请分为两个调用，以保留明确的操作顺序");
      if (
        !onlyManagement &&
        (management.selectArtifactIds !== undefined || management.discardArtifactIds !== undefined)
      )
        throw new Error("生成与最终产物管理请分为两个调用");
      if (management.selectArtifactIds !== undefined)
        artifacts.select(context.sessionId, context.runId, management.selectArtifactIds);
      if (management.discardArtifactIds !== undefined)
        artifacts.discard(context.sessionId, context.runId, management.discardArtifactIds);
      if (onlyManagement) {
        const selection = artifacts.selection(context.sessionId, context.runId);
        return {
          schemaVersion: "runtime-tool-output/v1",
          modelOutput: { status: "selected", selection },
          attachments: selection.selectedIds.map((id) => {
            const artifact = artifacts.describe(context.sessionId, id);
            return artifact.kind === "image"
              ? { type: "image", alt: artifact.name, url: `artifact://${id}` }
              : { type: "file", name: artifact.name, url: `artifact://${id}`, sizeBytes: artifact.size };
          })
        };
      }
      const raw = await tool.handle(execution, context);
      const output = readToolOutput(raw);
      if (output === undefined) throw new Error("Docker 工具结果无效");
      context.signal?.throwIfAborted();
      if (output.attachments.length === 0)
        return {
          ...output,
          modelOutput: {
            ...(output.modelOutput as Record<string, unknown>),
            status: (output.modelOutput as { exitCode?: number }).exitCode === 0 ? "generated" : "failed",
            selection: artifacts.selection(context.sessionId, context.runId)
          }
        };
      if (context.callId === undefined) throw new Error("Docker 工件缺少持久调用标识");
      const files = output.attachments.map((part) => {
        if ((part.type !== "file" && part.type !== "image") || !part.url?.startsWith("base64://"))
          throw new Error("Docker 工件传输无效");
        const encoded = part.url.slice(9);
        const data = Buffer.from(encoded, "base64");
        if (data.toString("base64") !== encoded) throw new Error("Docker 工件编码无效");
        return { name: part.type === "file" ? part.name : (part.alt ?? "image.png"), data, kind: part.type };
      });
      const saved = artifacts.save(
        { sessionId: context.sessionId, runId: context.runId, callId: context.callId },
        files
      );
      return {
        schemaVersion: "runtime-tool-output/v1",
        modelOutput: {
          ...(output.modelOutput as Record<string, unknown>),
          status: "generated",
          artifacts: saved,
          selection: artifacts.selection(context.sessionId, context.runId)
        },
        attachments: saved.map((artifact, index) => {
          const original = output.attachments[index]!;
          return { ...original, url: `artifact://${artifact.id}` };
        })
      };
    }
  };
}

/** 最终回复只保留当前选中的唯一引用，草稿和同 ID 重复附件不会进入交付 */
export function selectArtifactMessage(
  artifacts: ArtifactStore,
  sessionId: string,
  message: SynapseMessage
): SynapseMessage {
  const seen = new Set<string>();
  const segments = message.segments.filter((part) => {
    if ((part.type !== "file" && part.type !== "image") || !part.url?.startsWith("artifact://")) return true;
    const id = part.url.slice(11);
    const manifest = artifacts.describe(sessionId, id);
    if (manifest.disposition !== "selected" || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { ...message, segments };
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

/** 群文件复用统一上传回执仓储，文本失败后仍保留每个已交付工件的事实 */
export function createArtifactDelivery(
  artifacts: ArtifactStore,
  deliveries: ArtifactDeliveryStore,
  channels: ChannelRegistry
): NonNullable<RuntimeCoreOptions["prepareDelivery"]> {
  return async (input) => {
    if (input.conversationKind !== "group") return { status: "ready", message: input.message };
    const adapter = channels.get(input.channelId);
    if (!adapter?.uploadGroupFile) return { status: "ready", message: input.message };
    const segments: MessageSegment[] = [];
    for (const part of input.message.segments) {
      if (part.type !== "file" || !part.url?.startsWith("artifact://")) {
        segments.push(part);
        continue;
      }
      input.signal?.throwIfAborted();
      const artifactId = part.url.slice(11);
      const artifact = artifacts.read(input.sessionId, artifactId);
      input.observe("artifact_upload_started", { artifactId, automatic: true });
      // 保持原有附件顺序，逐个等待平台回执后再继续，禁止并行重复交付
      // eslint-disable-next-line no-await-in-loop
      const result = await deliveries.deliver(
        { sessionId: input.sessionId, channelId: input.channelId, groupId: input.conversationId, artifactId },
        () => adapter.uploadGroupFile!(input.conversationId, artifact)
      );
      input.signal?.throwIfAborted();
      input.observe(
        result.status === "succeeded"
          ? "artifact_upload_succeeded"
          : result.status === "uncertain"
            ? "artifact_upload_uncertain"
            : "artifact_upload_failed",
        { artifactId, ...result, automatic: true }
      );
      if (result.status !== "succeeded")
        return { status: result.status === "uncertain" ? "uncertain" : "failed", error: result.error };
    }
    return { status: "ready", message: { ...input.message, segments } };
  };
}

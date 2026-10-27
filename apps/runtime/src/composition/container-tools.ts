import { join } from "node:path";
import { z } from "zod";
import type { ChannelRegistry, ChannelAdapter } from "@synapse/runtime-channel";
import {
  ArtifactStore,
  ContainerExecutor,
  ContainerWorkInputSchema,
  type DockerCommandRunner
} from "@synapse/runtime-tool-container";
import type { ContainerSettings } from "@synapse/runtime-tool-container/config";
import type { ToolContext, ToolRuntime } from "@synapse/runtime-tool-runtime";
import { ArtifactDeliveryStore } from "./artifact-delivery.js";
import { canUploadGroupFile, deliverGroupArtifact } from "./channel-delivery.js";

const uploadInput = z.union([
  z.object({ operation: z.literal("upload").default("upload"), artifactId: z.string().uuid() }).strict(),
  z.object({ operation: z.enum(["select", "discard"]), artifactIds: z.array(z.string().uuid()).max(16) }).strict()
]);

/** 装配容器工作与群文件交付，所有文件归属和群目标均来自运行时上下文 */
export function registerContainerTools(options: {
  readonly tools: ToolRuntime;
  readonly settings: ContainerSettings;
  readonly dataDir: string;
  readonly channels: ChannelRegistry;
  readonly runner?: DockerCommandRunner;
}): void {
  if (!options.settings.enabled) return;
  const executor = new ContainerExecutor(options.settings, options.runner);
  const artifacts = new ArtifactStore(join(options.dataDir, "artifacts"), options.settings);
  const deliveries = new ArtifactDeliveryStore(join(options.dataDir, "artifact-deliveries"));
  options.tools.register({
    name: "container.run",
    description:
      "在无网络的本地 Python 容器中生成报告、表格、图片等文件，工作目录为 /work。outputs 声明要返回的单层文件名，inputs 可指定当前会话已有工件 ID。返回工件 ID，不会自动上传。请继续调用 artifact.upload 上传群文件。镜像中的依赖已由管理员安装，无法联网安装依赖。",
    inputSchema: z.toJSONSchema(ContainerWorkInputSchema),
    permission: { action: "container.execute", resource: "container" },
    async handle(raw, context) {
      requireGroupDestination(options.channels, context);
      if (context.callId === undefined) throw new Error("容器调用缺少持久化调用标识");
      const input = ContainerWorkInputSchema.parse(raw);
      const inputs = input.inputs.map((id) => artifacts.read(context.sessionId, id));
      let result;
      try {
        result = await executor.execute({ script: input.script, outputs: input.outputs }, inputs, context.signal);
      } catch (error) {
        // 已清理的失败任务没有外部副作用，允许模型修正脚本；清理未确认时必须停止后续工具调用
        if (error instanceof AggregateError) throw error;
        return {
          status: "failed",
          artifacts: [],
          error: (error instanceof Error ? error.message : "容器任务失败").slice(0, 2000)
        };
      }
      context.signal?.throwIfAborted();
      const saved = artifacts.save(
        { sessionId: context.sessionId, runId: context.runId, callId: context.callId },
        result.files
      );
      return {
        status: "generated",
        artifacts: saved,
        selection: artifacts.selection(context.sessionId, context.runId),
        logs: result.logs
      };
    }
  });
  options.tools.register({
    name: "artifact.upload",
    description:
      "默认 operation=upload，把 artifactId 对应的最终产物上传为本群群文件。operation=select 使用 artifactIds 替换本轮最终产物集合，operation=discard 废弃指定草稿；这两种管理操作不上传文件。只接受工件 ID，不接受路径、URL 或目标群。只有 succeeded 表示平台确认交付成功，selected/discarded 仅表示本地选择变更。uncertain 必须核对群文件且不得再次生成或上传以规避未知结果。",
    inputSchema: z.toJSONSchema(uploadInput),
    permission: { action: "channel.qq.upload_group_file", resource: "group-file" },
    async handle(raw, context) {
      const { adapter, channelId, groupId } = requireGroupDestination(options.channels, context);
      const input = uploadInput.parse(raw);
      context.signal?.throwIfAborted();
      if (input.operation !== "upload") {
        const selection =
          input.operation === "select"
            ? artifacts.select(context.sessionId, context.runId, input.artifactIds)
            : artifacts.discard(context.sessionId, context.runId, input.artifactIds);
        return { status: input.operation === "select" ? "selected" : "discarded", selection };
      }
      const { artifactId } = input;
      if (artifacts.describe(context.sessionId, artifactId).disposition !== "selected")
        throw new Error("工件未被选为最终产物，请先明确选择后再交付");
      const artifact = artifacts.read(context.sessionId, artifactId);
      context.signal?.throwIfAborted();
      const result = await deliverGroupArtifact(
        deliveries,
        adapter,
        { sessionId: context.sessionId, channelId, groupId, artifactId },
        artifact
      );
      return { ...result, artifactId, name: artifact.name, size: artifact.size, sha256: artifact.sha256 };
    }
  });
}

function requireGroupDestination(
  channels: ChannelRegistry,
  context: ToolContext
): { adapter: ChannelAdapter; channelId: string; groupId: string } {
  if (context.source?.conversationKind !== "group") throw new Error("0.1 的容器工件能力仅向群聊开放");
  const adapter = channels.get(context.source.channelId);
  if (adapter === undefined || !canUploadGroupFile(adapter)) throw new Error("当前频道不支持群文件上传");
  return { adapter, channelId: context.source.channelId, groupId: context.source.conversationId };
}

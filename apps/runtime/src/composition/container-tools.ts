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

const uploadInput = z.object({ artifactId: z.string().uuid() }).strict();

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
      return {
        status: "generated",
        artifacts: artifacts.save(
          { sessionId: context.sessionId, runId: context.runId, callId: context.callId },
          result.files
        ),
        logs: result.logs
      };
    }
  });
  options.tools.register({
    name: "artifact.upload",
    description:
      "把当前群会话已登记的工件直接上传为本群群文件。仅接受工件 ID，不接受路径、URL 或目标群。以返回的 status 为准，succeeded 才表示平台确认成功，uncertain 必须核对群文件且不得自动再次生成或上传以规避未知结果。",
    inputSchema: z.toJSONSchema(uploadInput),
    permission: { action: "channel.qq.upload_group_file", resource: "group-file" },
    async handle(raw, context) {
      const { adapter, groupId } = requireGroupDestination(options.channels, context);
      const { artifactId } = uploadInput.parse(raw);
      const artifact = artifacts.read(context.sessionId, artifactId);
      context.signal?.throwIfAborted();
      const result = await deliveries.deliver(
        { sessionId: context.sessionId, channelId: adapter.id, groupId, artifactId },
        () => adapter.uploadGroupFile!(groupId, artifact)
      );
      return { ...result, artifactId, name: artifact.name, size: artifact.size, sha256: artifact.sha256 };
    }
  });
}

function requireGroupDestination(
  channels: ChannelRegistry,
  context: ToolContext
): { adapter: ChannelAdapter; groupId: string } {
  if (context.source?.conversationKind !== "group") throw new Error("0.1 的容器工件能力仅向群聊开放");
  const adapter = channels.get(context.source.channelId);
  if (!adapter?.getCapabilities().uploadGroupFile || adapter.uploadGroupFile === undefined)
    throw new Error("当前频道不支持群文件上传");
  return { adapter, groupId: context.source.conversationId };
}

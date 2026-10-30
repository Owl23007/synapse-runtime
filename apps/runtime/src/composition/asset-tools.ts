import { ResourceOperationError, type AssetService, type ReadonlyMounts } from "@synapse/runtime-core/assets";
import type { Tool } from "@synapse/runtime-tool-runtime";
import { z } from "zod";
import { extractPdfText } from "./pdf-text.js";

/** 文件工具只从宿主工具上下文获取工作区，返回有界文本或二进制元数据 */
export function createAssetTools(assets: AssetService, mounts?: ReadonlyMounts): readonly Tool[] {
  const search = z
    .object({ query: z.string().max(500).optional(), limit: z.number().int().min(1).max(50).default(20) })
    .strict();
  const read = z
    .object({
      assetId: z.string().min(1),
      versionId: z.string().min(1).optional(),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(1).max(16000).default(8000)
    })
    .strict();
  const mountInput = z.object({ mountId: z.string().min(1), path: z.string().min(1).max(500) }).strict();
  return [
    {
      name: "asset.search",
      description: "搜索当前工作区文件，仅返回元数据；不会下载文件。多个同名候选时请用户确认",
      inputSchema: z.toJSONSchema(search),
      permission: { action: "asset.read", resource: "workspace:assets" },
      available: (context) => !!context.workspaceId,
      async handle(input, context) {
        if (!context.workspaceId) throw new ResourceOperationError(403, "workspace_required");
        return assets.index.list(context.workspaceId, search.parse(input));
      }
    },
    {
      name: "asset.read",
      description:
        "读取当前工作区文件的确定版本，首次读取按需下载并固定 Run 引用；文本按 offset/maxChars 分页，二进制返回类型和版本信息",
      inputSchema: z.toJSONSchema(read),
      permission: { action: "asset.read", resource: "workspace:assets" },
      available: (context) => !!context.workspaceId,
      async handle(input, context) {
        if (!context.workspaceId) throw new ResourceOperationError(403, "workspace_required");
        const value = read.parse(input);
        const result = await assets.read(
          {
            workspaceId: context.workspaceId,
            runId: context.runId,
            ...(context.taskId ? { taskId: context.taskId } : {})
          },
          value.assetId,
          value.versionId
        );
        let text = result.version.detectedMime.startsWith("text/plain") ? result.bytes.toString("utf8") : undefined;
        if (result.version.detectedMime === "application/pdf")
          text = await extractPdfText(result.bytes, context.signal);
        return {
          assetId: value.assetId,
          version: result.version,
          ...(text === undefined
            ? { binary: true, hint: "该文件为二进制，请使用 Files 预览或下载" }
            : {
                text: text.slice(value.offset, value.offset + value.maxChars),
                offset: value.offset,
                totalChars: text.length,
                hasMore: value.offset + value.maxChars < text.length
              })
        };
      }
    },
    ...(mounts
      ? [
          {
            name: "asset.mount_read",
            description:
              "将管理员配置的只读挂载文件固定为当前 Run 的资源版本；随后可用 asset.read 分页读取。只接受挂载 ID 与相对路径",
            inputSchema: z.toJSONSchema(mountInput),
            permission: { action: "asset.mount.read", resource: "workspace:mounts" },
            available: (context: Pick<import("@synapse/runtime-tool-runtime").ToolContext, "workspaceId">) =>
              !!context.workspaceId,
            async handle(input: unknown, context: import("@synapse/runtime-tool-runtime").ToolContext) {
              if (!context.workspaceId) throw new ResourceOperationError(403, "workspace_required");
              const value = mountInput.parse(input);
              const result = await mounts.materialize(assets, context.workspaceId, value.mountId, value.path);
              const pinned = await assets.read(
                {
                  workspaceId: context.workspaceId,
                  runId: context.runId,
                  ...(context.taskId ? { taskId: context.taskId } : {})
                },
                result.asset.id
              );
              return { assetId: result.asset.id, version: pinned.version };
            }
          } satisfies Tool
        ]
      : [])
  ];
}

import {
  AssetService,
  AssetBlobStore,
  ResourceIngress,
  ResourceOperationError,
  ReadonlyMounts
} from "@synapse/runtime-core/assets";
import type { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { executeChannelAction, type ChannelRegistry } from "@synapse/runtime-channel";
import { channelAction } from "@synapse/runtime-protocol";
import { createSafeFetch } from "@synapse/runtime-tool-web";
import type { RuntimeConfig } from "../config/index.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** 文件相关生产装配，平台协议和网络策略留在应用层 */
export function createFileResources(
  config: RuntimeConfig,
  context: SqliteRuntimeContextStore,
  channels: ChannelRegistry
) {
  const ingress = new ResourceIngress(context.assets, context, context);
  const mounts = new ReadonlyMounts(config.files.mounts, config.files.maxRemoteFetchBytes);
  const fetch = createSafeFetch({
    maxBytes: config.files.maxRemoteFetchBytes,
    privateHosts: config.files.remoteAllowedHosts
  });
  const assets = new AssetService(
    context.assets,
    new AssetBlobStore(join(config.runtime.dataDir, "assets"), config.files.cacheMaxBytes),
    config.files,
    async (source, signal) => {
      if (source.kind === "mount") {
        const { bytes } = await mounts.read(source.locator.mountId!, source.locator.path!);
        return (async function* () {
          yield bytes;
        })();
      }
      const channel = channels.get(source.locator.channelId ?? "");
      if (!channel || source.kind !== "qq_group" || channel.provider !== source.locator.provider)
        throw new ResourceOperationError(422, "file_source_unsupported");
      const result = await executeChannelAction(
        channel,
        channelAction({
          actionId: randomUUID(),
          actionType: "file.get",
          channelId: channel.id,
          target: { type: "group", groupId: source.locator.conversationId! },
          fileId: source.locator.fileId!,
          ...(source.locator.busid ? { busid: source.locator.busid } : {})
        })
      );
      if (result.status !== "succeeded" || result.data?.kind !== "file" || !result.data.file.url)
        throw new ResourceOperationError(result.status === "unsupported" ? 422 : 404, "remote_file_unavailable");
      const response = await fetch(result.data.file.url, { signal, redirect: "follow" });
      if (!response.ok || !response.body)
        throw new ResourceOperationError(response.status === 404 ? 404 : 502, "remote_file_download_failed");
      return response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
    }
  );
  return {
    assets,
    ingress,
    mounts,
    async syncFiles(channelId: string, groupId: string, folderId?: string) {
      const channel = channels.get(channelId);
      if (!channel) throw new ResourceOperationError(404, "channel_not_found");
      const result = await executeChannelAction(
        channel,
        channelAction({
          actionId: randomUUID(),
          actionType: "file.list",
          channelId,
          target: { type: "group", groupId },
          ...(folderId ? { folderId } : {})
        })
      );
      if (result.status !== "succeeded" || result.data?.kind !== "files")
        throw new ResourceOperationError(422, "file_list_unsupported_or_failed");
      const indexed = [];
      for (const file of result.data.items)
        indexed.push(
          await ingress.receive({
            channelId,
            provider: channel.provider,
            platform: "qq",
            conversation: { kind: "group", id: groupId },
            file: {
              fileId: file.id,
              name: file.name,
              ...(typeof file.extensions?.busid === "string" ? { busid: file.extensions.busid } : {})
            },
            observedAt: new Date().toISOString()
          })
        );
      return { items: indexed };
    }
  };
}

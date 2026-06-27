import type { ChannelAdapter } from "@synapse/runtime-channel";
import { QqOfficialChannelAdapter } from "@synapse/runtime-channel-qq-official";
import type { ChannelConfig } from "@synapse/runtime-config";
import type { RuntimeFetch } from "../types.js";

export function createChannelAdapter(
  channelId: string,
  channelConfig: ChannelConfig,
  options: { readonly fetch?: RuntimeFetch } = {}
): ChannelAdapter {
  if (channelConfig.adapter === "qq-official") {
    return new QqOfficialChannelAdapter({
      id: channelId,
      appId: channelConfig.appId,
      appSecret: channelConfig.appSecret,
      mode: channelConfig.mode,
      ...(channelConfig.apiBaseUrl === undefined ? {} : { apiBaseUrl: channelConfig.apiBaseUrl }),
      ...(channelConfig.tokenEndpoint === undefined ? {} : { tokenEndpoint: channelConfig.tokenEndpoint }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
  }

  throw new Error(`Channel adapter "${channelConfig.adapter}" is not implemented by runtime-server yet.`);
}

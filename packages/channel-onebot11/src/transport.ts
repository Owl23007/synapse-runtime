import type { ChannelStatus } from "@synapse/runtime-channel";
import type { OneBot11ResponsePayload } from "./types.js";

/** OneBot11 请求传输，不解释标准或扩展 API 的业务语义 */
export interface OneBot11Connection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ChannelStatus;
  call(action: string, params: Readonly<Record<string, unknown>>): Promise<OneBot11ResponsePayload>;
}

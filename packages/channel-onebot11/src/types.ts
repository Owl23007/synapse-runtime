export type OneBot11Transport = "websocket" | "http" | "http-websocket";

export interface OneBot11ChannelAdapterOptions {
  readonly id: string;
  readonly provider?: string;
  readonly transport?: OneBot11Transport;
  readonly endpoint: string;
  readonly accessToken?: string;
  readonly requestTimeoutMs?: number;
  readonly WebSocketCtor?: OneBot11WebSocketConstructor;
}

export interface OneBot11WebSocket {
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code?: number, reason?: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type OneBot11WebSocketConstructor = new (
  address: string,
  options?: { readonly headers?: Readonly<Record<string, string>> }
) => OneBot11WebSocket;

export interface OneBot11MessageEventPayload {
  readonly time?: number;
  readonly self_id?: number | string;
  readonly post_type?: string;
  readonly message_type?: "private" | "group" | string;
  readonly sub_type?: string;
  readonly message_id?: number | string;
  readonly user_id?: number | string;
  readonly group_id?: number | string;
  readonly raw_message?: string;
  readonly message?: unknown;
  readonly sender?: {
    readonly user_id?: number | string;
    readonly nickname?: string;
    readonly card?: string;
    readonly role?: string;
  };
}

export interface OneBot11ResponsePayload {
  readonly status?: string;
  readonly retcode?: number;
  readonly data?: unknown;
  readonly message?: string;
  readonly wording?: string;
  readonly echo?: string;
}

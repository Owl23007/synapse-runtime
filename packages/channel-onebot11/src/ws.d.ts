declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { AddressInfo } from "node:net";

  export interface ClientOptions {
    readonly headers?: Readonly<Record<string, string>>;
  }

  /** ws 客户端最小契约，发送成功回调允许返回 null */
  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: 0 | 1 | 2 | 3;

    constructor(address: string, options?: ClientOptions);

    send(data: string, callback?: (error?: Error | null) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }

  /** 本地协议回归测试使用的真实 WebSocket 服务端契约 */
  export class WebSocketServer extends EventEmitter {
    constructor(options: { readonly host: string; readonly port: number });
    address(): AddressInfo | string | null;
    close(callback?: (error?: Error) => void): void;
  }
}

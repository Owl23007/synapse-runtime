declare module "ws" {
  import type { EventEmitter } from "node:events";

  export interface ClientOptions {
    readonly headers?: Readonly<Record<string, string>>;
  }

  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: 0 | 1 | 2 | 3;

    constructor(address: string, options?: ClientOptions);

    send(data: string, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }
}

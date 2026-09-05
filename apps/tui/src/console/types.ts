/** 控制台日志级别 */
export type ConsoleLevel = "debug" | "info" | "warn" | "error";
/** 控制台连接生命周期 */
export type ConsoleStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
/** 控制台可见页面 */
export type ConsoleView = "overview" | "logs" | "config" | "channels" | "help";

/** 控制台连接与本地应用启动参数 */
export interface RuntimeConsoleOptions {
  readonly configPath: string;
  readonly envFile?: string;
  readonly runtimeEntry?: string;
  readonly workspaceConfigPath?: string;
  readonly userConfigPath?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly profile?: string;
  readonly profilePath?: string;
  readonly spawn?: boolean;
}

/** 服务端返回的频道展示摘要 */
export interface RuntimeConsoleChannelSummary {
  readonly id: string;
  readonly adapter: string;
  readonly enabled: boolean;
  readonly provider?: string;
  readonly status?: {
    readonly state?: string;
    readonly detail?: string;
    readonly checkedAt?: string;
  };
}

/** 控制台日志条目 */
export interface ConsoleLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: ConsoleLevel;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 控制台展示状态，不包含服务端配置模型 */
export interface ConsoleState {
  readonly status: ConsoleStatus;
  readonly view: ConsoleView;
  readonly configPath: string;
  readonly endpoint?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly logLevel?: ConsoleLevel;
  readonly started?: {
    readonly host: string;
    readonly port: number;
    readonly admin?: { readonly host: string; readonly port: number };
  };
  readonly channels?: readonly RuntimeConsoleChannelSummary[];
  readonly logs: readonly ConsoleLogEntry[];
  readonly notices: readonly string[];
}

/** 控制台状态订阅回调 */
export type StateListener = (state: ConsoleState) => void;

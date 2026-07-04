import type { RuntimeConfig } from "@synapse/runtime-config";
import { RuntimeAdminClient } from "../admin-client.js";
import { loadEnvFile, RuntimeServer } from "../index.js";
import { resolveRuntimeConnection } from "../profile-store.js";
import { parseAssignments, parseCommandValue, splitCommand, formatError } from "./commands.js";
import { addChannelConfigFile, updateChannelConfigFile } from "./config-editor.js";
import { ConsoleLogStore } from "./log-store.js";
import type {
  ConsoleLogEntry,
  ConsoleState,
  RuntimeConsoleChannelSummary,
  RuntimeConsoleOptions,
  StateListener
} from "./types.js";

export class RuntimeConsoleController {
  readonly #options: RuntimeConsoleOptions;
  readonly #logger = new ConsoleLogStore();
  readonly #listeners = new Set<StateListener>();
  #server: RuntimeServer | undefined;
  #client: RuntimeAdminClient | undefined;
  #state: ConsoleState;

  constructor(options: RuntimeConsoleOptions) {
    this.#options = options;
    this.#state = {
      status: "idle",
      view: "overview",
      configPath: options.configPath,
      logs: this.#logger.entries,
      notices: ["输入 /help 查看命令。"]
    };
    this.#logger.subscribe(() => this.#setState({ logs: this.#logger.entries }));
  }

  get snapshot(): ConsoleState {
    return this.#state;
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.#state.status !== "idle") {
      return;
    }

    this.#setState({ status: "starting" });

    try {
      if (this.#options.spawn === true) {
        await this.#startLocalRuntime();
        return;
      }

      await this.#connectRemoteRuntime();
    } catch (error) {
      this.#logger.error("Runtime console failed to start.", { error: formatError(error) });
      this.#setState({
        status: "failed",
        notices: [formatError(error)]
      });
    }
  }

  async stop(): Promise<void> {
    if (this.#state.status === "stopping" || this.#state.status === "stopped") {
      return;
    }

    this.#setState({ status: "stopping" });

    try {
      await this.#server?.stop();
      this.#setState({
        status: "stopped",
        notices: [this.#server === undefined ? "控制台已断开连接。" : "Runtime 已停止。"]
      });
    } catch (error) {
      this.#logger.error("Runtime console failed to stop.", { error: formatError(error) });
      this.#setState({ status: "failed", notices: [formatError(error)] });
    }
  }

  async execute(rawCommand: string): Promise<"exit" | "continue"> {
    const command = rawCommand.trim();

    if (command.length === 0) {
      return "continue";
    }

    const args = splitCommand(command);
    const name = args[0]?.toLowerCase();

    try {
      if (name === "/quit" || name === "/exit") {
        await this.stop();
        return "exit";
      }

      if (name === "/help") {
        this.#setState({ view: "help", notices: ["Showing available commands."] });
        return "continue";
      }

      if (name === "/status") {
        await this.#refreshRemoteState();
        this.#setState({ view: "overview", notices: [this.#formatStatus()] });
        return "continue";
      }

      if (name === "/logs") {
        await this.#refreshRemoteLogs();
        this.#setState({ view: "logs", notices: [`Showing ${this.#state.logs.length} buffered log entries.`] });
        return "continue";
      }

      if (name === "/config") {
        await this.#refreshRemoteConfig();
        this.#setState({ view: "config", notices: ["Showing redacted runtime config."] });
        return "continue";
      }

      if (name === "/channels") {
        await this.#refreshRemoteChannels();
        this.#setState({ view: "channels", notices: ["Showing configured channels."] });
        return "continue";
      }

      if (name === "/reload") {
        if (this.#client !== undefined) {
          const result = await this.#client.reload();
          this.#applyRemoteReload(result);
          this.#setState({ view: "overview", notices: ["远程配置已重载。"] });
          return "continue";
        }

        const config = await this.#loadConfig();
        this.#setState({ config, notices: ["Config reloaded. Restart console to reattach channels."] });
        return "continue";
      }

      if (name === "/channel") {
        await this.#executeChannelCommand(args.slice(1));
        return "continue";
      }

      this.#setState({ notices: [`Unknown command: ${name ?? command}. Type /help.`] });
      return "continue";
    } catch (error) {
      this.#logger.error("Console command failed.", { command, error: formatError(error) });
      this.#setState({ notices: [formatError(error)] });
      return "continue";
    }
  }

  async #executeChannelCommand(args: readonly string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    const channelId = args[1];

    if (action === undefined) {
      this.#setState({ view: "channels", notices: ["Usage: /channel enable|disable|set|add-qq-official ..."] });
      return;
    }

    if ((action === "enable" || action === "disable") && channelId !== undefined) {
      if (this.#client !== undefined) {
        await this.#client.updateChannel(channelId, { enabled: action === "enable" });
        await this.#refreshRemoteChannels();
        this.#setState({
          view: "channels",
          notices: [`频道 "${channelId}" 已${action === "enable" ? "启用" : "停用"}。`]
        });
        return;
      }

      await updateChannelConfigFile(this.#options.configPath, channelId, { enabled: action === "enable" });
      const config = await this.#loadConfig();
      this.#setState({
        config,
        view: "channels",
        notices: [`Channel "${channelId}" ${action}d in config. Restart console to apply runtime changes.`]
      });
      return;
    }

    if (action === "set" && channelId !== undefined) {
      const key = args[2];
      const value = args.slice(3).join(" ");

      if (key === undefined || value.length === 0) {
        this.#setState({ notices: ["Usage: /channel set <id> <key> <value>"] });
        return;
      }

      await updateChannelConfigFile(this.#options.configPath, channelId, { [key]: parseCommandValue(value) });
      const config = await this.#loadConfig();
      this.#setState({
        config,
        view: "channels",
        notices: [`Updated channel "${channelId}" field "${key}". Restart console to apply runtime changes.`]
      });
      return;
    }

    if (action === "add-qq-official" && channelId !== undefined) {
      const values = parseAssignments(args.slice(2));
      await addChannelConfigFile(this.#options.configPath, channelId, {
        adapter: "qq-official",
        appId: values.appId ?? values.appid ?? "",
        appSecret: values.appSecret ?? values.appsecret ?? "",
        mode: values.mode ?? "webhook",
        webhookPath: values.webhookPath ?? `/webhooks/qq-official/${channelId}`,
        enabled: values.enabled === undefined ? false : parseCommandValue(values.enabled),
        riskLevel: values.riskLevel ?? "low"
      });
      const config = await this.#loadConfig();
      this.#setState({
        config,
        view: "channels",
        notices: [`Added QQ official channel "${channelId}". Fill missing fields before enabling.`]
      });
      return;
    }

    this.#setState({
      view: "help",
      notices: [`Unknown /channel action: ${action}.`]
    });
  }

  async #loadConfig(): Promise<RuntimeConfig> {
    const { loadConfigFile } = await import("@synapse/runtime-config");
    return loadConfigFile(this.#options.configPath);
  }

  async #startLocalRuntime(): Promise<void> {
    if (this.#options.envFile !== undefined) {
      loadEnvFile(this.#options.envFile);
    }

    const config = await this.#loadConfig();
    const server = new RuntimeServer({ config, logger: this.#logger });
    this.#server = server;
    const started = await server.start();
    this.#setState({
      status: "running",
      config,
      started,
      ...(started.admin === undefined ? {} : { endpoint: `http://${started.admin.host}:${started.admin.port}` }),
      notices: [`Runtime 已启动：${started.host}:${started.port}。`]
    });
  }

  async #connectRemoteRuntime(): Promise<void> {
    const connection = await resolveRuntimeConnection({
      ...(this.#options.endpoint === undefined ? {} : { endpoint: this.#options.endpoint }),
      ...(this.#options.token === undefined ? {} : { token: this.#options.token }),
      ...(this.#options.profile === undefined ? {} : { profile: this.#options.profile }),
      ...(this.#options.profilePath === undefined ? {} : { profilePath: this.#options.profilePath })
    });
    this.#client = new RuntimeAdminClient({
      endpoint: connection.endpoint,
      ...(connection.token === undefined ? {} : { token: connection.token })
    });
    await this.#refreshRemoteState();
    this.#setState({
      status: "running",
      endpoint: connection.endpoint,
      notices: [
        `已连接 Admin API：${connection.endpoint}${connection.profile === undefined ? "" : ` (${connection.profile})`}。`
      ]
    });
  }

  async #refreshRemoteState(): Promise<void> {
    if (this.#client === undefined) {
      return;
    }

    const [status, config, logs] = await Promise.all([
      this.#client.status(),
      this.#client.config(),
      this.#client.logs({ limit: 100 })
    ]);
    this.#applyRemoteStatus(status);
    this.#applyRemoteConfig(config);
    this.#applyRemoteLogs(logs);
  }

  async #refreshRemoteConfig(): Promise<void> {
    if (this.#client === undefined) {
      return;
    }

    this.#applyRemoteConfig(await this.#client.config());
  }

  async #refreshRemoteChannels(): Promise<void> {
    if (this.#client === undefined) {
      return;
    }

    this.#applyRemoteChannels(await this.#client.channels());
  }

  async #refreshRemoteLogs(): Promise<void> {
    if (this.#client === undefined) {
      return;
    }

    this.#applyRemoteLogs(await this.#client.logs({ limit: 100 }));
  }

  #applyRemoteStatus(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    const server = isRecord(value.server) ? value.server : undefined;
    const admin = isRecord(value.admin) ? value.admin : undefined;
    const runtime = isRecord(value.runtime) ? value.runtime : undefined;
    const host = typeof server?.host === "string" ? server.host : "unknown";
    const port = typeof server?.port === "number" ? server.port : 0;
    const adminHost = typeof admin?.host === "string" ? admin.host : undefined;
    const adminPort = typeof admin?.port === "number" ? admin.port : undefined;
    const channels = Array.isArray(value.channels) ? parseChannelSummaries(value.channels) : undefined;

    this.#setState({
      started: {
        host,
        port,
        ...(adminHost === undefined || adminPort === undefined ? {} : { admin: { host: adminHost, port: adminPort } })
      },
      config: {
        ...this.#state.config,
        runtime: {
          ...this.#state.config?.runtime,
          mode: runtime?.mode === "attached" || runtime?.mode === "hosted" ? runtime.mode : "local",
          logLevel: parseLogLevel(runtime?.logLevel)
        }
      } as RuntimeConfig,
      ...(channels === undefined ? {} : { channels })
    });
  }

  #applyRemoteConfig(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.config)) {
      return;
    }

    this.#setState({ config: value.config as unknown as RuntimeConfig });
  }

  #applyRemoteChannels(value: unknown): void {
    if (!isRecord(value) || !Array.isArray(value.channels)) {
      return;
    }

    this.#setState({ channels: parseChannelSummaries(value.channels) });
  }

  #applyRemoteLogs(value: unknown): void {
    if (!isRecord(value) || !Array.isArray(value.logs)) {
      return;
    }

    this.#setState({ logs: parseLogEntries(value.logs) });
  }

  #applyRemoteReload(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    if (isRecord(value.config)) {
      this.#setState({ config: value.config as unknown as RuntimeConfig });
    }

    if (Array.isArray(value.channels)) {
      this.#setState({ channels: parseChannelSummaries(value.channels) });
    }
  }

  #formatStatus(): string {
    const address =
      this.#state.started === undefined ? "not listening" : `${this.#state.started.host}:${this.#state.started.port}`;
    return `状态=${this.#state.status} 服务=${address} 日志=${this.#state.logs.length}`;
  }

  #setState(patch: Partial<ConsoleState>): void {
    this.#state = { ...this.#state, ...patch };

    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }
}

function parseChannelSummaries(values: readonly unknown[]): RuntimeConsoleChannelSummary[] {
  return values.filter(isRecord).map((value) => ({
    id: typeof value.id === "string" ? value.id : "-",
    adapter: typeof value.adapter === "string" ? value.adapter : "-",
    enabled: value.enabled === true,
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(isRecord(value.status)
      ? {
          status: {
            ...(typeof value.status.state === "string" ? { state: value.status.state } : {}),
            ...(typeof value.status.detail === "string" ? { detail: value.status.detail } : {}),
            ...(typeof value.status.checkedAt === "string" ? { checkedAt: value.status.checkedAt } : {})
          }
        }
      : {})
  }));
}

function parseLogEntries(values: readonly unknown[]): ConsoleLogEntry[] {
  return values.filter(isRecord).map((value, index) => ({
    id: typeof value.id === "number" ? value.id : index + 1,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : new Date().toISOString(),
    level: parseLogLevel(value.level),
    message: typeof value.message === "string" ? value.message : JSON.stringify(value),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {})
  }));
}

function parseLogLevel(value: unknown): "debug" | "info" | "warn" | "error" {
  if (value === "debug" || value === "warn" || value === "error") {
    return value;
  }

  return "info";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

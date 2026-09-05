import { RuntimeAdminClient } from "@synapse/runtime-client";
import { resolveRuntimeConnection } from "@synapse/runtime-user-config";
import { LocalRuntimeProcess } from "../local-runtime.js";
import { parseAssignments, parseCommandValue, splitCommand, formatError } from "./commands.js";
import { ConsoleLogStore } from "./log-store.js";
import { isRecord, parseChannelSummaries, parseLogEntries, parseLogLevel } from "./response-parsers.js";
import type { ConsoleState, RuntimeConsoleOptions, StateListener } from "./types.js";

/** 通过 Admin API 驱动终端状态与操作 */
export class RuntimeConsoleController {
  readonly #options: RuntimeConsoleOptions;
  readonly #logger = new ConsoleLogStore();
  readonly #listeners = new Set<StateListener>();
  #server: LocalRuntimeProcess | undefined;
  readonly #abort = new AbortController();
  #client: RuntimeAdminClient | undefined;
  #unsubscribeRemoteLogs: (() => void) | undefined;
  #stopPromise: Promise<void> | undefined;
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
      await this.#server?.stop();
      if (this.#abort.signal.aborted) return;
      this.#logger.error("Runtime console failed to start.", { error: formatError(error) });
      this.#setState({
        status: "failed",
        notices: [formatError(error)]
      });
    }
  }

  stop(): Promise<void> {
    return (this.#stopPromise ??= this.#stop());
  }

  async #stop(): Promise<void> {
    if (this.#state.status === "stopping" || this.#state.status === "stopped") {
      return;
    }

    this.#abort.abort();
    this.#setState({ status: "stopping" });

    try {
      this.#unsubscribeRemoteLogs?.();
      this.#unsubscribeRemoteLogs = undefined;
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

        throw new Error("控制台尚未连接 Runtime");
      }

      if (name === "/channel") {
        await this.#executeChannelCommand(args.slice(1));
        return "continue";
      }

      this.#setState({ notices: [`Unknown command: ${name ?? command}. Type /help.`] });
      return "continue";
    } catch (error) {
      this.#logger.error("Console command failed.", { error: formatError(error) });
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

      throw new Error("控制台尚未连接 Runtime");
    }

    if (action === "set" && channelId !== undefined) {
      const key = args[2];
      const value = args.slice(3).join(" ");

      if (key === undefined || value.length === 0) {
        this.#setState({ notices: ["Usage: /channel set <id> <key> <value>"] });
        return;
      }

      if (!this.#client) throw new Error("控制台尚未连接 Runtime");
      await this.#client.updateChannelConfig(channelId, { [key]: parseCommandValue(value) });
      this.#setState({
        view: "channels",
        notices: [`Updated channel "${channelId}" field "${key}". 执行 /reload 应用服务端配置。`]
      });
      return;
    }

    if (action === "add-qq-official" && channelId !== undefined) {
      const values = parseAssignments(args.slice(2));
      if (!this.#client) throw new Error("控制台尚未连接 Runtime");
      await this.#client.addChannelConfig(channelId, {
        adapter: "qq-official",
        appId: values.appId ?? values.appid ?? "",
        appSecret: values.appSecret ?? values.appsecret ?? "",
        mode: values.mode ?? "webhook",
        webhookPath: values.webhookPath ?? `/webhooks/qq-official/${channelId}`,
        enabled: values.enabled === undefined ? false : parseCommandValue(values.enabled),
        riskLevel: values.riskLevel ?? "low"
      });
      this.#setState({
        view: "channels",
        notices: [`Added QQ official channel "${channelId}". 执行 /reload 应用服务端配置。`]
      });
      return;
    }

    this.#setState({
      view: "help",
      notices: [`Unknown /channel action: ${action}.`]
    });
  }

  async #startLocalRuntime(): Promise<void> {
    this.#server = new LocalRuntimeProcess(this.#options);
    const connection = await this.#server.start(this.#abort.signal);
    await this.#connectRemoteRuntime(connection);
  }

  async #connectRemoteRuntime(local?: { endpoint: string; token: string }): Promise<void> {
    const connection =
      local ??
      (await resolveRuntimeConnection({
        ...(this.#options.endpoint === undefined ? {} : { endpoint: this.#options.endpoint }),
        ...(this.#options.token === undefined ? {} : { token: this.#options.token }),
        ...(this.#options.profile === undefined ? {} : { profile: this.#options.profile }),
        ...(this.#options.profilePath === undefined ? {} : { profilePath: this.#options.profilePath })
      }));
    if (this.#abort.signal.aborted) return;
    this.#client = new RuntimeAdminClient({
      endpoint: connection.endpoint,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.any([this.#abort.signal, init?.signal ?? AbortSignal.timeout(15_000)])
        }),
      ...(connection.token === undefined ? {} : { token: connection.token })
    });
    await this.#refreshRemoteState();
    if (this.#abort.signal.aborted) return;
    this.#startRemoteLogStream();
    this.#setState({
      status: "running",
      endpoint: connection.endpoint,
      notices: [`已连接 Admin API：${connection.endpoint}。`]
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
      logLevel: parseLogLevel(runtime?.logLevel),
      ...(channels === undefined ? {} : { channels })
    });
  }

  #applyRemoteConfig(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.config)) {
      return;
    }

    this.#setState({ config: value.config });
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

  #appendRemoteLog(value: unknown): void {
    const entry = parseLogEntries([value])[0];

    if (entry === undefined) {
      return;
    }

    const existing = this.#state.logs.filter((item) => item.id !== entry.id);
    this.#setState({ logs: [...existing, entry].toSorted((left, right) => left.id - right.id).slice(-300) });
  }

  #startRemoteLogStream(): void {
    if (this.#client === undefined || this.#unsubscribeRemoteLogs !== undefined) {
      return;
    }

    this.#unsubscribeRemoteLogs = this.#client.streamLogs(
      (entry) => this.#appendRemoteLog(entry),
      (error) => {
        this.#logger.warn("Remote log stream disconnected.", { error: formatError(error) });
      }
    );
  }

  #applyRemoteReload(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    if (isRecord(value.config)) {
      this.#setState({ config: value.config });
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
    if (
      this.#abort.signal.aborted &&
      patch.status !== "stopping" &&
      patch.status !== "stopped" &&
      patch.status !== "failed"
    )
      return;
    this.#state = { ...this.#state, ...patch };

    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }
}

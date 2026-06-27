import type { RuntimeConfig } from "@synapse/runtime-config";
import { loadEnvFile, RuntimeServer } from "../index.js";
import { parseAssignments, parseCommandValue, splitCommand, formatError } from "./commands.js";
import { addChannelConfigFile, updateChannelConfigFile } from "./config-editor.js";
import { ConsoleLogStore } from "./log-store.js";
import type { ConsoleState, RuntimeConsoleOptions, StateListener } from "./types.js";

export class RuntimeConsoleController {
  readonly #options: RuntimeConsoleOptions;
  readonly #logger = new ConsoleLogStore();
  readonly #listeners = new Set<StateListener>();
  #server: RuntimeServer | undefined;
  #state: ConsoleState;

  constructor(options: RuntimeConsoleOptions) {
    this.#options = options;
    this.#state = {
      status: "idle",
      view: "overview",
      configPath: options.configPath,
      logs: this.#logger.entries,
      notices: [
        "Type /help for commands."
      ]
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
        notices: [`Runtime started on ${started.host}:${started.port}.`]
      });
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
      this.#setState({ status: "stopped", notices: ["Runtime stopped."] });
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
        this.#setState({ view: "overview", notices: [this.#formatStatus()] });
        return "continue";
      }

      if (name === "/logs") {
        this.#setState({ view: "logs", notices: [`Showing ${this.#state.logs.length} buffered log entries.`] });
        return "continue";
      }

      if (name === "/config") {
        this.#setState({ view: "config", notices: ["Showing redacted runtime config."] });
        return "continue";
      }

      if (name === "/channels") {
        this.#setState({ view: "channels", notices: ["Showing configured channels."] });
        return "continue";
      }

      if (name === "/reload") {
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

  #formatStatus(): string {
    const address = this.#state.started === undefined
      ? "not listening"
      : `${this.#state.started.host}:${this.#state.started.port}`;
    return `status=${this.#state.status} server=${address} logs=${this.#state.logs.length}`;
  }

  #setState(patch: Partial<ConsoleState>): void {
    this.#state = { ...this.#state, ...patch };

    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }
}

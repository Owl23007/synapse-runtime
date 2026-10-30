import { Client, StreamableHTTPClientTransport, type Tool as McpTool } from "@modelcontextprotocol/client";
import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { ToolCallRecoveryError, describeToolSet, type Tool } from "@synapse/runtime-tool-runtime";
import { createSafeFetch, type SafeFetchPolicy } from "@synapse/runtime-tool-web";
import type { McpServerSettings } from "./config.js";

/** 可观察的连接状态，远程工具变更后要求管理员重新发现 */
export interface McpConnectionStatus {
  readonly permissionAction?: string;
  readonly id: string;
  readonly state: "disconnected" | "connecting" | "connected" | "schema-changed" | "failed";
  readonly error?: string;
  readonly protocolVersion?: string;
  readonly serverVersion?: { readonly name: string; readonly version: string };
  readonly observedToolSetDigest?: string;
  readonly tools: readonly { name: string; description?: string; inputSchema: Readonly<Record<string, unknown>> }[];
}

/** 独立远程 MCP 连接，不执行本地进程且不会自动重试未知副作用 */
export class RemoteMcpConnection {
  #client: Client | undefined;
  #transport: StreamableHTTPClientTransport | undefined;
  #connecting: Promise<readonly Tool[]> | undefined;
  #definitions: readonly McpTool[] = [];
  #tools: readonly Tool[] = [];
  #status: McpConnectionStatus;
  #closed = false;
  /** 凭据只驻留内存；授权由 Runtime 工作区策略与用户权限共同完成 */
  constructor(
    readonly config: McpServerSettings,
    readonly options: {
      policy: SafeFetchPolicy;
      token?: string | undefined;
      timeoutMs: number;
      available: NonNullable<Tool["available"]>;
      permissionAction?: string;
      fetch?: typeof fetch;
    }
  ) {
    this.#status = { id: config.id, state: "disconnected", tools: [] };
  }

  /** 读取状态不会建立连接或执行请求 */
  get status(): McpConnectionStatus {
    return this.#status;
  }

  /** 并发连接合并为一次握手，发现后固定工具 Schema */
  connect(): Promise<readonly Tool[]> {
    if (this.#closed) return Promise.reject(new Error("MCP connection closed"));
    if (this.#status.state === "connected") return Promise.resolve(this.#tools);
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<readonly Tool[]> {
    this.#status = { ...this.#status, state: "connecting" };
    await this.#client?.close().catch(() => undefined);
    const client = new Client(
      { name: "synapse-runtime", version: "0.1.0" },
      {
        inputRequired: { autoFulfill: false },
        listMaxPages: 4,
        listChanged: {
          tools: {
            onChanged: (error) => {
              this.#status = {
                ...this.#status,
                state: error ? "failed" : "schema-changed",
                error: error ? "mcp_tool_discovery_failed" : "mcp_tool_schema_changed"
              };
            }
          }
        }
      }
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      fetch: this.options.fetch ?? createSafeFetch(this.options.policy),
      requestInit: {
        redirect: "error",
        ...(this.options.token ? { headers: { authorization: `Bearer ${this.options.token}` } } : {})
      },
      onInsufficientScope: "throw",
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1
      }
    });
    this.#client = client;
    this.#transport = transport;
    client.onclose = () => {
      if (this.#status.state === "connected")
        this.#status = { ...this.#status, state: "disconnected", error: "mcp_disconnected" };
    };
    client.onerror = () => {
      this.#status = { ...this.#status, state: "failed", error: "mcp_connection_failed" };
    };
    try {
      await client.connect(transport, { timeout: this.options.timeoutMs });
      const result = client.getServerCapabilities()?.tools
        ? await client.listTools({}, { timeout: this.options.timeoutMs })
        : { tools: [] };
      if (result.tools.length > 128 || JSON.stringify(result.tools).length > 200_000)
        throw new Error("MCP tool metadata exceeds budget");
      const safeDefinitions = this.options.token
        ? (JSON.parse(JSON.stringify(result.tools).split(this.options.token).join("[REDACTED]")) as typeof result.tools)
        : result.tools;
      this.#definitions = safeDefinitions;
      const ajv = new Ajv({ strict: false, validateFormats: false });
      this.#tools = safeDefinitions.map((definition) => {
        if (!definition.name || definition.name.length > 200 || JSON.stringify(definition.inputSchema).length > 32000)
          throw new Error("Invalid MCP tool metadata");
        const validate = ajv.compile(definition.inputSchema);
        return {
          name: `mcp:${this.config.id}/${definition.name}`,
          description: (definition.description ?? definition.name).slice(0, 4096),
          inputSchema: definition.inputSchema,
          permission: {
            action: this.options.permissionAction ?? `mcp.${this.config.id}.call`,
            resource: `mcp:${this.config.id}/${definition.name}`
          },
          available: (context) => this.#status.state === "connected" && this.options.available(context),
          handle: async (input, context) => {
            if (this.#status.state !== "connected" || !this.options.available(context))
              throw new Error("MCP tool is not enabled for workspace");
            if (!validate(input)) throw new Error("MCP tool arguments do not match installed schema");
            let result: Awaited<ReturnType<Client["callTool"]>>;
            try {
              result = await client.callTool(
                { name: definition.name, arguments: input as Record<string, unknown> },
                {
                  ...(context.signal ? { signal: context.signal } : {}),
                  timeout: Math.min(context.timeoutMs ?? this.options.timeoutMs, this.options.timeoutMs),
                  toolDefinition: definition
                }
              );
            } catch {
              this.#status = { ...this.#status, state: "failed", error: "mcp_request_failed" };
              if (definition.annotations?.readOnlyHint !== true)
                throw new ToolCallRecoveryError("outcome_uncertain", "MCP 外部操作结果未确认，禁止自动重放");
              throw new Error("MCP read request failed");
            }
            if (result.isError) throw new Error("MCP tool reported failure");
            const value = {
              content: result.content.map((item) =>
                item.type === "text"
                  ? { type: "text", text: item.text.slice(0, 16000) }
                  : { type: item.type, omitted: true }
              ),
              ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent })
            };
            let json = JSON.stringify(value);
            if (this.options.token) json = json.split(this.options.token).join("[REDACTED]");
            return json.length <= 32000 ? JSON.parse(json) : { text: json.slice(0, 32000), truncated: true };
          }
        } satisfies Tool;
      });
      const version = client.getServerVersion();
      this.#status = {
        id: this.config.id,
        state: "connected",
        permissionAction: this.options.permissionAction ?? `mcp.${this.config.id}.call`,
        tools: this.#definitions.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description.slice(0, 4096) } : {}),
          inputSchema: tool.inputSchema
        })),
        ...(client.getNegotiatedProtocolVersion() ? { protocolVersion: client.getNegotiatedProtocolVersion()! } : {}),
        ...(version
          ? {
              serverVersion: {
                name: this.options.token ? version.name.split(this.options.token).join("[REDACTED]") : version.name,
                version: this.options.token
                  ? version.version.split(this.options.token).join("[REDACTED]")
                  : version.version
              }
            }
          : {}),
        observedToolSetDigest: describeToolSet(this.#tools).digest
      };
      return this.#tools;
    } catch {
      this.#status = { ...this.#status, state: "failed", error: "mcp_initialize_or_discovery_failed" };
      await client.close().catch(() => undefined);
      throw new Error("MCP initialization failed");
    }
  }

  /** 显式重新发现可能变化的 Schema，调用方应重新生成 Run 工具快照 */
  async refresh(): Promise<readonly Tool[]> {
    this.#status = { ...this.#status, state: "disconnected" };
    return this.connect();
  }

  /** 先终止远端会话再关闭连接，关闭后不接受新请求 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#connecting?.catch(() => undefined);
    await this.#transport?.terminateSession().catch(() => undefined);
    await this.#client?.close().catch(() => undefined);
    this.#status = { ...this.#status, state: "disconnected" };
  }
}

import type {
  PermissionDecision,
  PermissionEngine,
  PermissionPolicy,
  PermissionRequest
} from "@synapse/runtime-permission";

export interface PermissionRequirement {
  readonly action: string;
  readonly resource: string;
  readonly defaultPolicy?: PermissionPolicy;
}

export interface ToolContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolContext
) => Promise<TOutput>;

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly permission: PermissionRequirement;
  handle(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolCallResult<TOutput = unknown> {
  readonly status: "succeeded" | "blocked";
  readonly output?: TOutput;
  readonly reason?: string;
}

export class ToolRuntime {
  readonly #tools = new Map<string, Tool>();
  readonly #permissionEngine: PermissionEngine;

  constructor(permissionEngine: PermissionEngine) {
    this.#permissionEngine = permissionEngine;
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }

    this.#tools.set(tool.name, tool);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  async decidePermission(request: PermissionRequest): Promise<PermissionDecision> {
    return this.#permissionEngine.decide(request);
  }

  async call<TOutput = unknown>(name: string, input: unknown, context: ToolContext): Promise<ToolCallResult<TOutput>> {
    const tool = this.#tools.get(name);

    if (tool === undefined) {
      throw new Error(`Tool "${name}" is not registered.`);
    }

    const decision = await this.#permissionEngine.decide({
      action: tool.permission.action,
      resource: tool.permission.resource,
      subject: context.userId
    });

    if (decision.decision !== "allow") {
      return {
        status: "blocked",
        reason: decision.reason ?? `Permission decision was "${decision.decision}".`
      };
    }

    return {
      status: "succeeded",
      output: (await tool.handle(input, context)) as TOutput
    };
  }
}

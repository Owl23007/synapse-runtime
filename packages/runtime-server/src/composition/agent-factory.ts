import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import { ApiChatAgent, OpenAiCompatibleChatProvider, type ChatCompletionProvider } from "@synapse/runtime-agent-api-provider";
import type { AgentProviderConfig, RuntimeConfig } from "@synapse/runtime-config";
import { getTextContent, textMessage } from "@synapse/runtime-protocol";
import type { RuntimeFetch } from "../types.js";

export function createAgentFromConfig(config: RuntimeConfig, options: { readonly fetch?: RuntimeFetch } = {}): Agent {
  const providerId = config.agent.default;

  if (providerId === undefined) {
    return new EchoAgent({ id: "echo-agent", prefix: "" });
  }

  const providerConfig = config.agent.providers[providerId];

  if (providerConfig === undefined) {
    throw new Error(`Agent provider "${providerId}" is not defined.`);
  }

  if (providerConfig.type === "echo") {
    return new EchoAgent({ id: providerId, prefix: providerConfig.prefix });
  }

  return new ApiChatAgent({
    id: providerId,
    provider: createChatProvider(providerId, providerConfig, options),
    ...(config.agent.systemPrompt === undefined ? {} : { systemPrompt: config.agent.systemPrompt })
  });
}

export function createChatProvider(
  providerId: string,
  providerConfig: AgentProviderConfig,
  options: { readonly fetch?: RuntimeFetch } = {}
): ChatCompletionProvider {
  if (providerConfig.type === "openai-compatible") {
    return new OpenAiCompatibleChatProvider({
      id: providerId,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      ...(providerConfig.temperature === undefined ? {} : { temperature: providerConfig.temperature }),
      ...(providerConfig.maxTokens === undefined ? {} : { maxTokens: providerConfig.maxTokens }),
      ...(providerConfig.topP === undefined ? {} : { topP: providerConfig.topP }),
      headers: providerConfig.headers,
      extraBody: providerConfig.extraBody,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
  }

  throw new Error(`Agent provider "${providerId}" is not a chat completion provider.`);
}

class EchoAgent implements Agent {
  readonly id: string;
  readonly #prefix: string;

  constructor(options: { readonly id: string; readonly prefix: string }) {
    this.id = options.id;
    this.#prefix = options.prefix;
  }

  async run(request: Parameters<Agent["run"]>[0]): Promise<AgentRun> {
    const text = `${this.#prefix}${getTextContent(request.input)}`;

    return {
      id: `run-${request.event.id}`,
      agentId: this.id,
      sessionId: request.sessionId,
      status: "succeeded",
      input: request.input,
      steps: [],
      output: textMessage(text)
    };
  }
}

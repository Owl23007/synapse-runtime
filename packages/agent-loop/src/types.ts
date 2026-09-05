import type { ChatCompletionProvider } from "@synapse/runtime-agent-core";
/** 工具型聊天智能体配置 */
export interface ApiChatAgentOptions {
  readonly id: string;
  readonly provider: ChatCompletionProvider;
  /** 单次运行允许的最大模型步数 */
  readonly maxSteps?: number;
  /** 单次运行允许的最大工具调用数 */
  readonly maxToolCalls?: number;
}

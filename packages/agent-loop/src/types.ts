import type { ChatCompletionProvider } from "@synapse/runtime-agent-core";
/** 工具型聊天智能体配置 */
export interface ApiChatAgentOptions {
  /** 最终模型输入总字符预算，包含系统提示、历史、工具定义和工具观察 */
  readonly maxInputChars?: number;
  /** 每轮请求的输出 token 预留，未知实际 usage 仍保持未知 */
  readonly maxOutputTokens?: number;
  readonly id: string;
  readonly provider: ChatCompletionProvider;
  /** 单次运行允许的最大模型步数 */
  readonly maxSteps?: number;
  /** 单次运行允许的最大工具调用数 */
  readonly maxToolCalls?: number;
}

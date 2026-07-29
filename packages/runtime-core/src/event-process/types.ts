import type { ConversationType } from "../context/types.js";

export type EventProcessStatus =
  | "received"
  | "processing"
  | "agent_completed"
  | "send_succeeded"
  | "send_failed"
  | "completed";

export interface EventProcessState {
  readonly id: string;
  readonly status: EventProcessStatus;
  readonly updatedAt: string;
  readonly incomingMessageId?: string;
  readonly assistantMessageId?: string;
  readonly agentOutputText?: string;
  readonly agentOutputJson?: string;
  readonly sendResultJson?: string;
  readonly errorJson?: string;
}

export interface EventProcessBeginInput {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
}

export interface EventProcessClaimInput {
  readonly expectedStatus: EventProcessStatus;
  readonly expectedUpdatedAt: string;
}

export interface EventProcessClaim {
  readonly claimed: boolean;
  readonly state: EventProcessState;
}

export interface EventProcessStore {
  /** 获取或创建来源事件的处理状态 */
  begin(input: EventProcessBeginInput): Promise<EventProcessState>;
  /** 以乐观并发方式声明事件处理权 */
  claim?(id: string, input: EventProcessClaimInput): Promise<EventProcessClaim>;
  /** 更新事件处理检查点 */
  update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): Promise<EventProcessState>;
}

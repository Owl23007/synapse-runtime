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
}

export interface EventProcessStore {
  begin(input: EventProcessBeginInput): Promise<EventProcessState>;
  update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): Promise<EventProcessState>;
}

export type ConversationType = "private" | "group" | "channel" | "cli" | "system";
export type WorkspaceType = "personal" | "group" | "system";

export interface PlatformIdentity {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly platformUserId: string;
  readonly displayName?: string;
}

export interface SynapseIdentity {
  readonly id: string;
  readonly type: "guest" | "owner" | "system";
  readonly trustLevel: "guest" | "owner" | "system";
  readonly displayName?: string;
  readonly roles: readonly string[];
}

export interface RuntimeActor {
  readonly identity: SynapseIdentity;
  readonly platformIdentity: PlatformIdentity;
  readonly isBound: boolean;
}

export interface WorkspaceRef {
  readonly id: string;
  readonly type: WorkspaceType;
  readonly name: string;
}

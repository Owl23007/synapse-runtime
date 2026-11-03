import type {
  AcceptNormalizedEventInput,
  AcceptedNormalizedEvent,
  AppendLineEventInput,
  BranchContext,
  BranchPublication,
  BranchResult,
  BranchResultTrace,
  ConversationBranch,
  ConversationLine,
  ConversationMainline,
  ConversationRecoveryState,
  ConversationSession,
  CreateBranchInput,
  CreateBranchResultInput,
  CreateSessionInput,
  EventTrace,
  LineEvent,
  ListBranchesOptions,
  ListLineEventsOptions,
  ListLinesOptions,
  NormalizedEvent,
  PublishBranchResultInput,
  TransitionBranchInput,
  TransitionSessionInput
} from "./types.js";

/**
 * 会话领域的持久化与查询契约
 */
export interface ConversationStore {
  /** 原子接收并持久化归一化事件 */
  acceptNormalizedEvent(input: AcceptNormalizedEventInput): Promise<AcceptedNormalizedEvent>;
  /** 按标识读取归一化事件 */
  getNormalizedEvent(eventId: string): Promise<NormalizedEvent | undefined>;
  /** 列出会话中的归一化事件 */
  listNormalizedEvents(sessionId: string): Promise<readonly NormalizedEvent[]>;

  /** 创建会话及其主线 */
  createSession(input: CreateSessionInput): Promise<ConversationSession>;
  /** 获取或创建会话及其主线 */
  ensureSession(input: CreateSessionInput): Promise<ConversationSession>;
  /** 按标识读取会话 */
  getSession(sessionId: string): Promise<ConversationSession | undefined>;
  /** 迁移会话状态 */
  transitionSession(sessionId: string, input: TransitionSessionInput): Promise<ConversationSession>;

  /** 按标识读取会话线 */
  getLine(lineId: string): Promise<ConversationLine | undefined>;
  /** 读取会话主线 */
  getMainline(sessionId: string): Promise<ConversationMainline>;
  /** 列出会话线 */
  listLines(sessionId: string, options?: ListLinesOptions): Promise<readonly ConversationLine[]>;

  /** 创建隔离分支 */
  createBranch(input: CreateBranchInput): Promise<ConversationBranch>;
  /** 按标识读取分支 */
  getBranch(branchId: string): Promise<ConversationBranch | undefined>;
  /** 列出会话分支 */
  listBranches(sessionId: string, options?: ListBranchesOptions): Promise<readonly ConversationBranch[]>;
  /** 迁移分支状态 */
  transitionBranch(branchId: string, input: TransitionBranchInput): Promise<ConversationBranch>;

  /** 向会话线追加不可变事件 */
  appendEvent(lineId: string, input: AppendLineEventInput): Promise<LineEvent>;
  /** 按标识读取会话线事件 */
  getEvent(eventId: string): Promise<LineEvent | undefined>;
  /** 列出会话线事件 */
  listEvents(lineId: string, options?: ListLineEventsOptions): Promise<readonly LineEvent[]>;

  /** 创建结构化分支结果 */
  createBranchResult(branchId: string, input: CreateBranchResultInput): Promise<BranchResult>;
  /** 按标识读取分支结果 */
  getBranchResult(resultId: string): Promise<BranchResult | undefined>;
  /** 列出分支结果 */
  listBranchResults(branchId: string): Promise<readonly BranchResult[]>;
  /** 将分支结果发布到主线 */
  publishBranchResult(
    branchId: string,
    mainlineId: string,
    input?: PublishBranchResultInput
  ): Promise<BranchPublication>;

  /** 读取分支执行上下文 */
  getBranchContext(branchId: string): Promise<BranchContext>;
  /** 读取未完成工作的恢复视图 */
  getRecoveryState(sessionId?: string): Promise<ConversationRecoveryState>;
  /** 追踪事件因果关系 */
  getEventTrace(eventId: string): Promise<EventTrace>;
  /** 追踪分支结果及其发布关系 */
  getBranchResultTrace(resultId: string): Promise<BranchResultTrace>;
}

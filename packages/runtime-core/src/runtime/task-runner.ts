import type {
  BranchResult,
  ConversationBranch,
  ConversationStore,
  ConversationTask,
  CreateTaskInput
} from "../conversation/index.js";

export interface TaskExecutionContext {
  readonly task: ConversationTask;
  readonly branch: ConversationBranch;
  readonly signal: AbortSignal;
}

export interface TaskExecutionResult {
  readonly output?: unknown;
  readonly summary: string;
  readonly artifacts?: readonly unknown[];
  readonly citations?: readonly unknown[];
  readonly nextActions?: readonly string[];
}

export type TaskExecutor = (input: unknown, context: TaskExecutionContext) => Promise<TaskExecutionResult>;

export interface TaskRunnerOptions {
  readonly store: ConversationStore;
  readonly executors: Readonly<Record<string, TaskExecutor>>;
}

export interface TaskRunnerRecovery {
  readonly resumedTaskIds: readonly string[];
  readonly failedTaskIds: readonly string[];
}

/**
 * Executes durable branch tasks and always closes them with a published branch
 * result. Started work is never replayed after a restart because its external
 * side effects may have completed before the process stopped.
 */
export class TaskRunner {
  readonly #store: ConversationStore;
  readonly #executors: Readonly<Record<string, TaskExecutor>>;
  readonly #running = new Map<
    string,
    { readonly abort: AbortController; readonly completion: Promise<BranchResult> }
  >();

  constructor(options: TaskRunnerOptions) {
    this.#store = options.store;
    this.#executors = options.executors;
  }

  async start(branchId: string, input: CreateTaskInput): Promise<ConversationTask> {
    const task = await this.#store.createTask(branchId, input);
    this.#schedule(task);
    return task;
  }

  wait(taskId: string): Promise<BranchResult> {
    const running = this.#running.get(taskId);
    if (running === undefined) {
      return Promise.reject(new Error(`Task "${taskId}" is not running in this process.`));
    }
    return running.completion;
  }

  async cancel(taskId: string): Promise<ConversationTask> {
    const task = await this.#store.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task "${taskId}" was not found.`);
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return task;
    }

    this.#running.get(taskId)?.abort.abort();
    const cancelled = await this.#store.transitionTask(taskId, {
      status: "cancelled",
      error: { code: "cancelled", message: "Task was cancelled." },
      idempotencyKey: `task-runner:${taskId}:cancelled`
    });
    await this.#finish(cancelled, "cancelled", "Task was cancelled.");
    return cancelled;
  }

  async recover(sessionId?: string): Promise<TaskRunnerRecovery> {
    const recovery = await this.#store.getRecoveryState(sessionId);
    const outcomes = await recovery.unfinishedTasks.reduce<
      Promise<readonly { readonly id: string; readonly resumed: boolean }[]>
    >(async (pendingOutcomes, task) => {
      const previous = await pendingOutcomes;
      if (task.status === "pending" && this.#executors[task.executor] !== undefined) {
        this.#schedule(task);
        return [...previous, { id: task.id, resumed: true }];
      }

      const recoverable =
        task.status === "pending"
          ? await this.#store.transitionTask(task.id, {
              status: "running",
              idempotencyKey: `task-runner:${task.id}:recovery-running`
            })
          : task;
      const failed = await this.#store.transitionTask(recoverable.id, {
        status: "failed",
        error: {
          code: task.status === "pending" ? "executor_unavailable" : "outcome_uncertain",
          message:
            task.status === "pending"
              ? `Executor "${task.executor}" is not available after restart.`
              : "Task was active when the runtime stopped; it was not replayed because its outcome is uncertain."
        },
        idempotencyKey: `task-runner:${task.id}:recovery-failed`
      });
      await this.#finish(
        failed,
        "failed",
        task.status === "pending"
          ? `Task could not resume because executor "${task.executor}" is unavailable.`
          : "Task did not resume because its pre-restart outcome is uncertain."
      );
      return [...previous, { id: task.id, resumed: false }];
    }, Promise.resolve([]));

    return {
      resumedTaskIds: outcomes.filter((outcome) => outcome.resumed).map((outcome) => outcome.id),
      failedTaskIds: outcomes.filter((outcome) => !outcome.resumed).map((outcome) => outcome.id)
    };
  }

  async dispose(): Promise<void> {
    for (const running of this.#running.values()) {
      running.abort.abort();
    }
    await Promise.allSettled([...this.#running.values()].map((running) => running.completion));
  }

  #schedule(task: ConversationTask): void {
    if (this.#running.has(task.id)) {
      return;
    }
    const abort = new AbortController();
    const completion = this.#execute(task, abort.signal).finally(() => {
      this.#running.delete(task.id);
    });
    this.#running.set(task.id, { abort, completion });
  }

  async #execute(task: ConversationTask, signal: AbortSignal): Promise<BranchResult> {
    const running =
      task.status === "pending"
        ? await this.#store.transitionTask(task.id, {
            status: "running",
            idempotencyKey: `task-runner:${task.id}:running`
          })
        : task;
    const executor = this.#executors[task.executor];
    if (executor === undefined) {
      const failed = await this.#store.transitionTask(running.id, {
        status: "failed",
        error: { code: "executor_unavailable", message: `Executor "${task.executor}" is not registered.` },
        idempotencyKey: `task-runner:${task.id}:executor-unavailable`
      });
      return this.#finish(failed, "failed", `Executor "${task.executor}" is not registered.`);
    }

    const branch = await this.#requireBranch(task.branchId);
    if (branch.status !== "active") {
      await this.#store.transitionBranch(branch.id, {
        status: "active",
        idempotencyKey: `task-runner:${task.id}:branch-active`
      });
    }
    try {
      const result = await executor(running.input, { task: running, branch, signal });
      const current = await this.#store.getTask(task.id);
      if (current?.status === "cancelled") {
        return this.#requireLatestResult(task.branchId);
      }
      const completed = await this.#store.transitionTask(task.id, {
        status: "completed",
        output: result.output,
        ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
        idempotencyKey: `task-runner:${task.id}:completed`
      });
      return this.#finish(completed, "completed", result.summary, result);
    } catch (error) {
      const current = await this.#store.getTask(task.id);
      if (current?.status === "cancelled") {
        return this.#requireLatestResult(task.branchId);
      }
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.#store.transitionTask(task.id, {
        status: "failed",
        error: { message },
        idempotencyKey: `task-runner:${task.id}:failed`
      });
      return this.#finish(failed, "failed", message);
    }
  }

  async #finish(
    task: ConversationTask,
    status: BranchResult["status"],
    summary: string,
    execution?: TaskExecutionResult
  ): Promise<BranchResult> {
    const existing = (await this.#store.listBranchResults(task.branchId)).find((result) =>
      result.sourceTaskIds.includes(task.id)
    );
    if (existing !== undefined) {
      return existing;
    }

    const result = await this.#store.createBranchResult(task.branchId, {
      status,
      summary,
      artifacts: execution?.artifacts ?? task.artifacts,
      ...(execution?.citations === undefined ? {} : { citations: execution.citations }),
      ...(execution?.nextActions === undefined ? {} : { nextActions: execution.nextActions }),
      sourceTaskIds: [task.id],
      ...(task.sourceEventId === undefined ? {} : { sourceEventId: task.sourceEventId }),
      idempotencyKey: `task-runner:${task.id}:result:${status}`
    });
    const branch = await this.#requireBranch(task.branchId);
    if (branch.status !== status) {
      await this.#store.transitionBranch(branch.id, {
        status,
        idempotencyKey: `task-runner:${task.id}:branch-${status}`
      });
    }
    if (status === "completed") {
      const mainline = await this.#store.getMainline(task.sessionId);
      await this.#store.publishBranchResult(branch.id, mainline.id, {
        resultId: result.id,
        idempotencyKey: `task-runner:${task.id}:publish`
      });
    }
    return result;
  }

  async #requireBranch(branchId: string): Promise<ConversationBranch> {
    const branch = await this.#store.getBranch(branchId);
    if (branch === undefined) {
      throw new Error(`Branch "${branchId}" was not found.`);
    }
    return branch;
  }

  async #requireLatestResult(branchId: string): Promise<BranchResult> {
    const results = await this.#store.listBranchResults(branchId);
    const latest = results.at(-1);
    if (latest === undefined) {
      throw new Error(`Branch "${branchId}" has no result.`);
    }
    return latest;
  }
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import {
  InMemoryChannelRegistry,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelEventHandler,
  type ChannelStatus,
  type ChannelTarget,
  type SendResult
} from "@synapse/runtime-channel";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import { ToolRuntime, type ToolContext } from "@synapse/runtime-tool-runtime";
import {
  InMemoryConversationStore,
  InMemoryEventProcessStore,
  InMemoryTranscriptStore,
  RuntimeCore,
  SqliteRuntimeContextStore,
  type AppendLineEventInput,
  type EventProcessState
} from "./index.js";

const SESSION_ID = "qq:napcat:qq-local:private:user-1";

class RecordingChannel implements ChannelAdapter {
  readonly id = "qq-local";
  readonly type = "onebot11";
  readonly provider = "napcat";
  readonly sent: Array<{ readonly target: ChannelTarget; readonly message: SynapseMessage }> = [];
  readonly #handlers = new Set<ChannelEventHandler>();

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getStatus(): Promise<ChannelStatus> {
    return { state: "online", checkedAt: new Date(0).toISOString() };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      receivePrivateMessage: true,
      receiveGroupMessage: true,
      receiveAllGroupMessages: true,
      requiresMention: false,
      sendPrivateMessage: true,
      sendGroupMessage: true,
      sendMedia: false,
      manageGroup: false,
      recallMessage: false,
      complianceLevel: "community",
      riskLevel: "high"
    };
  }

  async sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult> {
    this.sent.push({ target, message });
    return { ok: true, messageId: `sent-${this.sent.length}` };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async emit(event: SynapseChannelEvent): Promise<void> {
    await Promise.all([...this.#handlers].map((handler) => handler(event)));
  }
}

class FailOnceDeliveryStore extends SqliteRuntimeContextStore {
  #failed = false;

  override async appendEvent(lineId: string, input: AppendLineEventInput) {
    if (input.type === "delivery_succeeded" && !this.#failed) {
      this.#failed = true;
      throw new Error("injected delivery event persistence failure");
    }
    return super.appendEvent(lineId, input);
  }
}

class FailOnceAgentCompletedStore extends SqliteRuntimeContextStore {
  #failed = false;

  override async update(
    id: string,
    patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>
  ): Promise<EventProcessState> {
    if (patch.status === "agent_completed" && !this.#failed) {
      this.#failed = true;
      throw new Error("injected agent completion checkpoint failure");
    }
    return super.update(id, patch);
  }
}

class FailOnceAgentCompletionEventStore extends SqliteRuntimeContextStore {
  #failed = false;

  override async appendEvent(lineId: string, input: AppendLineEventInput) {
    if (input.type === "agent_run_completed" && !this.#failed) {
      this.#failed = true;
      throw new Error("injected agent completion event persistence failure");
    }
    return super.appendEvent(lineId, input);
  }
}

class FailOnceToolResultStore extends SqliteRuntimeContextStore {
  #failed = false;

  override async appendEvent(lineId: string, input: AppendLineEventInput) {
    if (input.type === "tool_result" && !this.#failed) {
      this.#failed = true;
      throw new Error("injected tool result persistence failure");
    }
    return super.appendEvent(lineId, input);
  }
}

class FailOnceSendSucceededStore extends SqliteRuntimeContextStore {
  #failed = false;

  override async update(
    id: string,
    patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>
  ): Promise<EventProcessState> {
    if (patch.status === "send_succeeded" && !this.#failed) {
      this.#failed = true;
      throw new Error("injected post-send checkpoint failure");
    }
    return super.update(id, patch);
  }
}

describe("RuntimeCore branch isolation and recovery", () => {
  it("records a thrown agent attempt as failed and permits an immediate retry", async () => {
    const channel = new RecordingChannel();
    const conversationStore = new InMemoryConversationStore();
    const eventProcessStore = new InMemoryEventProcessStore();
    let attempts = 0;
    const agent: Agent = {
      id: "retry-agent",
      async run(request): Promise<AgentRun> {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient provider failure");
        }
        return successfulRun("retry-run-2", request.sessionId, request.input, "recovered");
      }
    };
    const runtime = createRuntime({
      channel,
      agent,
      conversationStore,
      eventProcessStore,
      transcriptStore: new InMemoryTranscriptStore()
    });
    const event = privateEvent("retry-event", "please retry");

    await channel.emit(event);
    const mainline = await conversationStore.getMainline(SESSION_ID);
    expect((await conversationStore.listEvents(mainline.id)).map((item) => item.type)).toEqual([
      "user_message",
      "context_attributed",
      "agent_run_started",
      "agent_run_failed"
    ]);
    expect(channel.sent).toHaveLength(0);

    await channel.emit(event);

    expect(attempts).toBe(2);
    expect(channel.sent).toHaveLength(1);
    const events = await conversationStore.listEvents(mainline.id);
    expect(events.filter((item) => item.type === "agent_run_started")).toHaveLength(2);
    expect(events.filter((item) => item.type === "agent_run_failed")).toHaveLength(1);
    expect(events.filter((item) => item.type === "agent_run_completed")).toHaveLength(1);
    expect(events.find((item) => item.type === "agent_run_failed")?.payload).toMatchObject({
      status: "failed",
      error: { name: "Error", message: "transient provider failure" }
    });
    expect(runtime.traces.map((trace) => trace.status)).toEqual(["failed", "succeeded"]);
  });

  it("atomically claims a duplicate event so concurrent deliveries run the agent only once", async () => {
    const channel = new RecordingChannel();
    const conversationStore = new InMemoryConversationStore();
    let releaseAgent!: () => void;
    const agentReleased = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let announceAgentStarted!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      announceAgentStarted = resolve;
    });
    let runs = 0;
    const agent: Agent = {
      id: "concurrent-agent",
      async run(request): Promise<AgentRun> {
        runs += 1;
        announceAgentStarted();
        await agentReleased;
        return successfulRun("concurrent-run", request.sessionId, request.input, "once");
      }
    };
    const runtime = createRuntime({
      channel,
      agent,
      conversationStore,
      eventProcessStore: new InMemoryEventProcessStore(),
      transcriptStore: new InMemoryTranscriptStore()
    });
    const event = privateEvent("concurrent-event", "only process me once");

    const firstDelivery = runtime.handleChannelEvent(event, "napcat");
    await agentStarted;
    await runtime.handleChannelEvent(event, "napcat");

    expect(runs).toBe(1);
    expect(channel.sent).toHaveLength(0);
    releaseAgent();
    await firstDelivery;

    expect(runs).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(runtime.traces).toContainEqual(
      expect.objectContaining({ eventId: event.id, status: "ignored", reason: "already_processing" })
    );
  });

  it("replays a completed tool call after restart without repeating its side effect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-tool-replay-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const event = privateEvent("tool-replay-event", "run the durable tool");
    let agentRuns = 0;
    let toolSideEffects = 0;
    const agent: Agent = {
      id: "tool-replay-agent",
      async run(request, context): Promise<AgentRun> {
        agentRuns += 1;
        const result = await context.tools.call<{ readonly receipt: string }>(
          "side.effect",
          { value: 42 },
          { runId: `tool-replay-run-${agentRuns}` }
        );
        expect(result).toEqual({ status: "succeeded", output: { receipt: "once" } });
        if (agentRuns === 1) {
          throw new Error("injected crash after durable tool completion");
        }
        return successfulRun(`tool-replay-run-${agentRuns}`, request.sessionId, request.input, "recovered safely");
      }
    };
    let firstStore: SqliteRuntimeContextStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;

    try {
      firstStore = new SqliteRuntimeContextStore({ databasePath });
      const firstTools = durableSideEffectTools(() => {
        toolSideEffects += 1;
      });
      const firstChannel = new RecordingChannel();
      const firstRuntime = createRuntime({
        channel: firstChannel,
        agent,
        tools: firstTools,
        conversationStore: firstStore,
        eventProcessStore: firstStore,
        transcriptStore: firstStore
      });

      await firstChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(toolSideEffects).toBe(1);
      expect(firstChannel.sent).toHaveLength(0);
      const mainline = await firstStore.getMainline(SESSION_ID);
      const firstEvents = await firstStore.listEvents(mainline.id);
      expect(firstEvents.filter((item) => item.type === "tool_call")).toHaveLength(1);
      expect(firstEvents.filter((item) => item.type === "tool_result")).toHaveLength(1);
      firstRuntime.dispose();
      firstStore.close();
      firstStore = undefined;

      secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondTools = durableSideEffectTools(() => {
        toolSideEffects += 1;
      });
      const secondChannel = new RecordingChannel();
      createRuntime({
        channel: secondChannel,
        agent,
        tools: secondTools,
        conversationStore: secondStore,
        eventProcessStore: secondStore,
        transcriptStore: secondStore
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(2);
      expect(toolSideEffects).toBe(1);
      expect(secondChannel.sent).toHaveLength(1);
      const recoveredEvents = await secondStore.listEvents(mainline.id);
      expect(recoveredEvents.filter((item) => item.type === "tool_call")).toHaveLength(1);
      expect(recoveredEvents.filter((item) => item.type === "tool_result")).toHaveLength(1);
      expect(recoveredEvents.find((item) => item.type === "tool_call")?.payload).toMatchObject({
        callId: expect.stringMatching(/^tool-call:normalized-event:.*:1$/),
        name: "side.effect",
        input: { value: 42 }
      });
    } finally {
      secondStore?.close();
      firstStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not repeat a tool whose persisted call has an uncertain outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-tool-uncertain-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const event = privateEvent("tool-uncertain-event", "run the uncertain tool");
    let agentRuns = 0;
    let toolSideEffects = 0;
    const agent: Agent = {
      id: "tool-uncertain-agent",
      async run(_request, context): Promise<AgentRun> {
        agentRuns += 1;
        await context.tools.call("side.effect", { value: 7 }, { runId: `tool-uncertain-run-${agentRuns}` });
        throw new Error("unreachable after uncertain tool outcome");
      }
    };
    let firstStore: FailOnceToolResultStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;

    try {
      firstStore = new FailOnceToolResultStore({ databasePath });
      const firstChannel = new RecordingChannel();
      const firstRuntime = createRuntime({
        channel: firstChannel,
        agent,
        tools: durableSideEffectTools(() => {
          toolSideEffects += 1;
        }),
        conversationStore: firstStore,
        eventProcessStore: firstStore,
        transcriptStore: firstStore
      });

      await firstChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(toolSideEffects).toBe(1);
      const mainline = await firstStore.getMainline(SESSION_ID);
      expect((await firstStore.listEvents(mainline.id)).filter((item) => item.type === "tool_result")).toHaveLength(0);
      firstRuntime.dispose();
      firstStore.close();
      firstStore = undefined;

      secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondChannel = new RecordingChannel();
      const secondRuntime = createRuntime({
        channel: secondChannel,
        agent,
        tools: durableSideEffectTools(() => {
          toolSideEffects += 1;
        }),
        conversationStore: secondStore,
        eventProcessStore: secondStore,
        transcriptStore: secondStore
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(2);
      expect(toolSideEffects).toBe(1);
      expect(secondChannel.sent).toHaveLength(0);
      const recoveredEvents = await secondStore.listEvents(mainline.id);
      expect(recoveredEvents.filter((item) => item.type === "tool_call")).toHaveLength(1);
      expect(recoveredEvents.filter((item) => item.type === "tool_result")).toHaveLength(1);
      expect(recoveredEvents.find((item) => item.type === "tool_result")?.payload).toMatchObject({
        status: "uncertain",
        callId: expect.stringMatching(/^tool-call:normalized-event:.*:1$/)
      });
      expect(secondRuntime.traces.at(-1)).toMatchObject({
        eventId: event.id,
        status: "failed",
        reason: expect.stringContaining("durable result is unknown")
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(2);
      expect(toolSideEffects).toBe(1);
      expect(secondRuntime.traces.at(-1)).toMatchObject({
        eventId: event.id,
        status: "ignored",
        reason: "duplicate_completed"
      });
    } finally {
      secondStore?.close();
      firstStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drains an in-flight tool call before removing persistence observers during disposal", async () => {
    const channel = new RecordingChannel();
    const conversationStore = new InMemoryConversationStore();
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const tools = new ToolRuntime(
      new StaticPermissionEngine({
        "tool.slow_write": "allow",
        "channel.qq.send_private_message": "allow"
      })
    );
    tools.register({
      name: "slow.write",
      description: "A delayed side effect.",
      permission: { action: "tool.slow_write", resource: "slow-write" },
      async handle() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { receipt: "persisted-before-close" };
      }
    });
    const agent: Agent = {
      id: "drain-agent",
      async run(request, context): Promise<AgentRun> {
        await context.tools.call("slow.write", {}, { runId: "drain-run" });
        return successfulRun("drain-run", request.sessionId, request.input, "drained");
      }
    };
    const runtime = createRuntime({
      channel,
      agent,
      tools,
      conversationStore,
      eventProcessStore: new InMemoryEventProcessStore(),
      transcriptStore: new InMemoryTranscriptStore()
    });
    const handling = runtime.handleChannelEvent(privateEvent("drain-event", "finish before shutdown"), "napcat");
    await toolStarted.promise;

    const disposal = runtime.dispose();
    expect(runtime.dispose()).toBe(disposal);
    let disposalSettled = false;
    void disposal.then(() => {
      disposalSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    releaseTool.resolve();
    await Promise.all([handling, disposal]);

    const mainline = await conversationStore.getMainline(SESSION_ID);
    const events = await conversationStore.listEvents(mainline.id);
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool_result")?.payload).toMatchObject({
      status: "succeeded",
      output: { receipt: "persisted-before-close" }
    });
    expect(channel.sent).toHaveLength(1);
  });

  it("lets an agent create an idempotent scoped branch and exposes the same host entry point", async () => {
    const channel = new RecordingChannel();
    const conversationStore = new InMemoryConversationStore();
    let agentBranchId: string | undefined;
    const agent: Agent = {
      id: "branch-creator-agent",
      async run(request, context): Promise<AgentRun> {
        const input = {
          title: "Investigate separately",
          goal: "Keep the investigation isolated",
          reason: "The work needs an independent context",
          idempotencyKey: "investigation"
        };
        const first = await context.conversation.createBranch(input);
        const replay = await context.conversation.createBranch(input);
        expect(replay).toEqual(first);
        agentBranchId = first.id;
        return successfulRun("branch-creator-run", request.sessionId, request.input, "branch created");
      }
    };
    const runtime = createRuntime({
      channel,
      agent,
      conversationStore,
      eventProcessStore: new InMemoryEventProcessStore(),
      transcriptStore: new InMemoryTranscriptStore()
    });

    await channel.emit(privateEvent("branch-create-event", "handle this separately"));

    const mainline = await conversationStore.getMainline(SESSION_ID);
    const sourceEvent = (await conversationStore.listEvents(mainline.id)).find((item) => item.type === "user_message");
    expect(agentBranchId).toBeDefined();
    await expect(conversationStore.getBranch(agentBranchId ?? "")).resolves.toMatchObject({
      sessionId: SESSION_ID,
      parentMainlineId: mainline.id,
      sourceEventId: sourceEvent?.id,
      createdBy: agent.id,
      status: "created",
      contextSnapshot: {
        sourceEventId: sourceEvent?.id,
        sourceText: "handle this separately"
      }
    });
    expect(await conversationStore.listBranches(SESSION_ID)).toHaveLength(1);

    const scheduled = await runtime.createBranch({
      sessionId: SESSION_ID,
      sourceEventId: sourceEvent?.id ?? "",
      title: "Scheduled follow-up",
      goal: "Demonstrate the host rule and scheduler entry point",
      reason: "A host policy requested it",
      createdBy: "scheduler",
      idempotencyKey: "scheduled-follow-up"
    });
    expect(scheduled).toMatchObject({
      sessionId: SESSION_ID,
      parentMainlineId: mainline.id,
      sourceEventId: sourceEvent?.id,
      createdBy: "scheduler"
    });
    expect(await conversationStore.listBranches(SESSION_ID)).toHaveLength(2);
  });

  it("repairs a missing delivery event after restart without sending the assistant output twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-delivery-recovery-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const event = privateEvent("delivery-recovery-event", "hello");
    let agentRuns = 0;
    const agent: Agent = {
      id: "delivery-agent",
      async run(request): Promise<AgentRun> {
        agentRuns += 1;
        return successfulRun("delivery-run-1", request.sessionId, request.input, "persist me");
      }
    };
    let firstStore: FailOnceDeliveryStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;

    try {
      firstStore = new FailOnceDeliveryStore({ databasePath });
      const firstChannel = new RecordingChannel();
      createRuntime({
        channel: firstChannel,
        agent,
        conversationStore: firstStore,
        eventProcessStore: firstStore,
        transcriptStore: firstStore
      });

      await firstChannel.emit(event);
      expect(firstChannel.sent).toHaveLength(1);
      const firstMainline = await firstStore.getMainline(SESSION_ID);
      expect(
        (await firstStore.listEvents(firstMainline.id)).filter((item) => item.type === "delivery_succeeded")
      ).toEqual([]);
      firstStore.close();
      firstStore = undefined;

      secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondChannel = new RecordingChannel();
      createRuntime({
        channel: secondChannel,
        agent,
        conversationStore: secondStore,
        eventProcessStore: secondStore,
        transcriptStore: secondStore
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(secondChannel.sent).toHaveLength(0);
      const recoveredDeliveryEvents = (await secondStore.listEvents(firstMainline.id)).filter(
        (item) => item.type === "delivery_succeeded"
      );
      expect(recoveredDeliveryEvents).toHaveLength(1);
      expect(recoveredDeliveryEvents[0]?.payload).toMatchObject({
        externalMessageId: "sent-1",
        recovered: true
      });
    } finally {
      secondStore?.close();
      firstStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers a completed rich agent output after its completion checkpoint fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-agent-checkpoint-recovery-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const event = privateEvent("agent-checkpoint-recovery-event", "make a diagram");
    const richOutput: SynapseMessage = {
      type: "mixed",
      segments: [
        { type: "text", text: "persist this complete output" },
        { type: "image", url: "https://example.invalid/diagram.png", alt: "diagram" }
      ]
    };
    let agentRuns = 0;
    const agent: Agent = {
      id: "agent-checkpoint-agent",
      async run(request): Promise<AgentRun> {
        agentRuns += 1;
        return {
          ...successfulRun("agent-checkpoint-run", request.sessionId, request.input, "unused"),
          output: richOutput
        };
      }
    };
    let firstStore: FailOnceAgentCompletedStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;

    try {
      firstStore = new FailOnceAgentCompletedStore({ databasePath });
      const firstChannel = new RecordingChannel();
      createRuntime({
        channel: firstChannel,
        agent,
        conversationStore: firstStore,
        eventProcessStore: firstStore,
        transcriptStore: firstStore
      });

      await firstChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(firstChannel.sent).toHaveLength(0);
      const firstMainline = await firstStore.getMainline(SESSION_ID);
      expect(
        (await firstStore.listEvents(firstMainline.id)).filter((item) => item.type === "agent_run_completed")
      ).toHaveLength(1);
      firstStore.close();
      firstStore = undefined;
      expect(readPersistedAgentOutput(databasePath)).toEqual(richOutput);
      markEventProcessesStale(databasePath);

      secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondChannel = new RecordingChannel();
      createRuntime({
        channel: secondChannel,
        agent,
        conversationStore: secondStore,
        eventProcessStore: secondStore,
        transcriptStore: secondStore
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(secondChannel.sent).toHaveLength(1);
      expect(secondChannel.sent[0]?.message.segments).toEqual([{ type: "text", text: "persist this complete output" }]);
      const recoveredEvents = await secondStore.listEvents(firstMainline.id);
      expect(recoveredEvents.filter((item) => item.type === "agent_run_started")).toHaveLength(1);
      expect(recoveredEvents.filter((item) => item.type === "agent_run_completed")).toHaveLength(1);
      expect(recoveredEvents.filter((item) => item.type === "delivery_succeeded")).toHaveLength(1);
    } finally {
      secondStore?.close();
      firstStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the agent completion event when a crash occurs after the output checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-agent-event-recovery-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const event = privateEvent("agent-event-recovery-event", "finish durably");
    let agentRuns = 0;
    const agent: Agent = {
      id: "agent-event-recovery-agent",
      async run(request): Promise<AgentRun> {
        agentRuns += 1;
        return successfulRun("agent-event-recovery-run", request.sessionId, request.input, "durable result");
      }
    };
    let firstStore: FailOnceAgentCompletionEventStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;

    try {
      firstStore = new FailOnceAgentCompletionEventStore({ databasePath });
      const firstChannel = new RecordingChannel();
      createRuntime({
        channel: firstChannel,
        agent,
        conversationStore: firstStore,
        eventProcessStore: firstStore,
        transcriptStore: firstStore
      });

      await firstChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(firstChannel.sent).toHaveLength(0);
      const mainline = await firstStore.getMainline(SESSION_ID);
      expect(
        (await firstStore.listEvents(mainline.id)).filter((item) => item.type === "agent_run_completed")
      ).toHaveLength(0);
      firstStore.close();
      firstStore = undefined;
      markEventProcessesStale(databasePath);

      secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondChannel = new RecordingChannel();
      createRuntime({
        channel: secondChannel,
        agent,
        conversationStore: secondStore,
        eventProcessStore: secondStore,
        transcriptStore: secondStore
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(secondChannel.sent).toHaveLength(1);
      const recoveredCompletionEvents = (await secondStore.listEvents(mainline.id)).filter(
        (item) => item.type === "agent_run_completed"
      );
      expect(recoveredCompletionEvents).toHaveLength(1);
      expect(recoveredCompletionEvents[0]?.payload).toMatchObject({
        status: "succeeded",
        recovered: true,
        output: textMessage("durable result")
      });
    } finally {
      secondStore?.close();
      firstStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not resend when delivery succeeded but its post-send checkpoint failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-uncertain-delivery-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const event = privateEvent("uncertain-delivery-event", "send exactly once");
    let agentRuns = 0;
    const agent: Agent = {
      id: "uncertain-delivery-agent",
      async run(request): Promise<AgentRun> {
        agentRuns += 1;
        return successfulRun("uncertain-delivery-run", request.sessionId, request.input, "one delivery");
      }
    };
    let firstStore: FailOnceSendSucceededStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;

    try {
      firstStore = new FailOnceSendSucceededStore({ databasePath });
      const firstChannel = new RecordingChannel();
      createRuntime({
        channel: firstChannel,
        agent,
        conversationStore: firstStore,
        eventProcessStore: firstStore,
        transcriptStore: firstStore
      });

      await firstChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(firstChannel.sent).toHaveLength(1);
      const firstMainline = await firstStore.getMainline(SESSION_ID);
      expect(
        (await firstStore.listEvents(firstMainline.id)).filter((item) => item.type === "delivery_succeeded")
      ).toHaveLength(0);
      firstStore.close();
      firstStore = undefined;
      markEventProcessesStale(databasePath);

      secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondChannel = new RecordingChannel();
      const secondRuntime = createRuntime({
        channel: secondChannel,
        agent,
        conversationStore: secondStore,
        eventProcessStore: secondStore,
        transcriptStore: secondStore
      });

      await secondChannel.emit(event);

      expect(agentRuns).toBe(1);
      expect(secondChannel.sent).toHaveLength(0);
      const recoveredEvents = await secondStore.listEvents(firstMainline.id);
      expect(recoveredEvents.filter((item) => item.type === "delivery_succeeded")).toHaveLength(0);
      expect(recoveredEvents.filter((item) => item.type === "delivery_uncertain")).toHaveLength(1);
      expect(secondRuntime.traces).toContainEqual(
        expect.objectContaining({
          eventId: event.id,
          status: "failed",
          reason: "delivery_outcome_uncertain"
        })
      );
    } finally {
      secondStore?.close();
      firstStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens legacy branch state while publishing and delivering its isolated result through the mainline", async () => {
    const channel = new RecordingChannel();
    const channels = new InMemoryChannelRegistry();
    channels.register(channel);
    const conversationStore = new InMemoryConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const seed = await conversationStore.acceptNormalizedEvent({
      sessionId: SESSION_ID,
      platform: "qq",
      provider: "napcat",
      channelId: "qq-local",
      conversationType: "private",
      conversationId: "user-1",
      sourceEventId: "seed-source",
      sourceMessageId: "seed-message",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "Investigate this separately",
      message: { id: "seed-message", ...textMessage("Investigate this separately") },
      receivedAt: "2026-07-26T08:00:00.000Z",
      idempotencyKey: "seed-normalized"
    });
    const branch = await conversationStore.createBranch({
      id: "branch-investigation",
      sessionId: SESSION_ID,
      parentMainlineId: seed.mainline.id,
      sourceEventId: seed.lineEvent.id,
      title: "Isolated investigation",
      goal: "Inspect a tool result without polluting the mainline",
      reason: "tool-heavy work",
      createdBy: "agent",
      idempotencyKey: "create-investigation-branch",
      contextSnapshot: { mainlineSummary: "The user requested an isolated investigation." }
    });
    await conversationStore.transitionBranch(branch.id, {
      status: "active",
      idempotencyKey: "legacy-investigation-active"
    });
    await conversationStore.transitionBranch(branch.id, {
      status: "completed",
      idempotencyKey: "legacy-investigation-completed"
    });
    const tools = new ToolRuntime(
      new StaticPermissionEngine({
        "tool.branch.echo": "allow",
        "channel.qq.send_private_message": "allow"
      })
    );
    let toolContext: ToolContext | undefined;
    tools.register({
      name: "branch.echo",
      description: "Echo branch input.",
      permission: { action: "tool.branch.echo", resource: "branch:echo" },
      async handle(input, context) {
        toolContext = context;
        return input;
      }
    });
    let observedLineState = "";
    let observedLineId: string | undefined;
    let observedBranchId: string | undefined;
    const agent: Agent = {
      id: "branch-agent",
      async run(request, context): Promise<AgentRun> {
        observedLineState =
          request.promptContext?.sections
            .flatMap((section) => section.blocks)
            .find((block) => block.id === "line-state")?.content ?? "";
        observedLineId = request.lineId;
        observedBranchId = request.branchId;
        await context.tools.call(
          "branch.echo",
          { value: 42 },
          {
            runId: "branch-run-1"
          }
        );
        return successfulRun("branch-run-1", request.sessionId, request.input, "branch-only answer");
      }
    };
    const runtime = new RuntimeCore({
      channels,
      conversation: privateConversationRouter(false),
      agent,
      tools,
      context: {
        conversationStore,
        transcriptStore,
        eventProcessStore: new InMemoryEventProcessStore(),
        providerByChannelId: { "qq-local": "napcat" }
      }
    });
    const branchEvent = privateEvent("branch-input-event", "continue the isolated investigation");

    await runtime.handleChannelEvent(branchEvent, "napcat", branch.id);

    expect(observedLineId).toBe(branch.id);
    expect(observedBranchId).toBe(branch.id);
    expect(observedLineState).toContain('"kind":"branch"');
    expect(observedLineState).toContain('"goal":"Inspect a tool result without polluting the mainline"');
    expect(observedLineState).toContain('"mainlineSummary":"The user requested an isolated investigation."');
    expect(toolContext).toMatchObject({
      runId: "branch-run-1",
      attemptId: expect.stringMatching(/^agent-attempt-/),
      sessionId: SESSION_ID,
      userId: "guest:qq:napcat:qq-local:user-1",
      lineId: branch.id,
      branchId: branch.id
    });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message).toMatchObject(textMessage("branch-only answer"));

    const mainlineEvents = await conversationStore.listEvents(seed.mainline.id);
    expect(mainlineEvents.map((item) => item.type)).toEqual(["user_message", "branch_result", "delivery_succeeded"]);
    expect(mainlineEvents[1]).toMatchObject({
      type: "branch_result",
      payload: expect.objectContaining({
        branchId: branch.id,
        summary: "branch-only answer",
        artifacts: [expect.objectContaining({ kind: "assistant_output", text: "branch-only answer" })]
      })
    });
    const branchEvents = await conversationStore.listEvents(branch.id);
    expect(branchEvents.map((item) => item.type)).toEqual([
      "branch_created",
      "branch_status_changed",
      "branch_status_changed",
      "user_message",
      "context_attributed",
      "branch_status_changed",
      "branch_status_changed",
      "agent_run_started",
      "tool_call",
      "tool_result",
      "agent_run_completed",
      "assistant_message",
      "branch_result",
      "branch_result_published"
    ]);
    await expect(conversationStore.getBranch(branch.id)).resolves.toMatchObject({ status: "active" });
    const incomingBranchEvent = branchEvents.find((item) => item.type === "user_message");
    const toolCallEvent = branchEvents.find((item) => item.type === "tool_call");
    const toolResultEvent = branchEvents.find((item) => item.type === "tool_result");
    expect(toolCallEvent).toMatchObject({
      lineId: branch.id,
      sourceEventId: incomingBranchEvent?.id,
      causationEventId: incomingBranchEvent?.id
    });
    expect(toolResultEvent).toMatchObject({
      lineId: branch.id,
      sourceEventId: incomingBranchEvent?.id,
      causationEventId: toolCallEvent?.id,
      correlationId: toolCallEvent?.correlationId
    });
    const toolTrace = await conversationStore.getEventTrace(toolResultEvent?.id ?? "");
    expect(toolTrace.causationChain.map((item) => item.type)).toEqual(["user_message", "tool_call", "tool_result"]);
    expect(toolTrace.relatedEvents.map((item) => item.type)).toEqual(
      expect.arrayContaining(["agent_run_started", "agent_run_completed", "assistant_message"])
    );
    expect(await transcriptStore.listRecent(SESSION_ID, { lineId: branch.id })).toMatchObject([
      { role: "user", text: "continue the isolated investigation" },
      { role: "assistant", text: "branch-only answer" }
    ]);
  });
});

function createRuntime(input: {
  readonly channel: RecordingChannel;
  readonly agent: Agent;
  readonly tools?: ToolRuntime;
  readonly conversationStore: InMemoryConversationStore | SqliteRuntimeContextStore;
  readonly eventProcessStore: InMemoryEventProcessStore | SqliteRuntimeContextStore;
  readonly transcriptStore: InMemoryTranscriptStore | SqliteRuntimeContextStore;
}): RuntimeCore {
  const channels = new InMemoryChannelRegistry();
  const tools =
    input.tools ??
    new ToolRuntime(
      new StaticPermissionEngine({
        "channel.qq.send_private_message": "allow"
      })
    );
  const runtime = new RuntimeCore({
    channels,
    conversation: privateConversationRouter(),
    agent: input.agent,
    tools,
    context: {
      conversationStore: input.conversationStore,
      eventProcessStore: input.eventProcessStore,
      transcriptStore: input.transcriptStore,
      providerByChannelId: { "qq-local": "napcat" }
    }
  });
  runtime.attachChannel(input.channel);
  return runtime;
}

function privateConversationRouter(includeHistory = true): ConversationRouter {
  return new ConversationRouter({
    groupTrigger: { mode: "never" },
    privateTrigger: { mode: "always" },
    contextPolicy: { includeHistory, maxMessages: 20 }
  });
}

function privateEvent(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "user-1", kind: "private" },
    sender: { id: "user-1" },
    message: { id: `message-${id}`, ...textMessage(text) },
    raw: { id, text },
    receivedAt: "2026-07-26T08:30:00.000Z"
  };
}

function successfulRun(id: string, sessionId: string, input: SynapseMessage, output: string): AgentRun {
  return {
    id,
    agentId: "test-agent",
    sessionId,
    status: "succeeded",
    input,
    steps: [],
    output: textMessage(output)
  };
}

function durableSideEffectTools(onSideEffect: () => void): ToolRuntime {
  const tools = new ToolRuntime(
    new StaticPermissionEngine({
      "tool.side_effect": "allow",
      "channel.qq.send_private_message": "allow"
    })
  );
  tools.register({
    name: "side.effect",
    description: "A side-effecting test tool.",
    permission: { action: "tool.side_effect", resource: "side-effect" },
    async handle() {
      onSideEffect();
      return { receipt: "once" };
    }
  });
  return tools;
}

function markEventProcessesStale(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.prepare("UPDATE event_process_state SET updated_at = ?").run("2000-01-01T00:00:00.000Z");
  } finally {
    database.close();
  }
}

function readPersistedAgentOutput(databasePath: string): SynapseMessage | undefined {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare("SELECT agent_output_json FROM event_process_state LIMIT 1").get() as
      | { readonly agent_output_json?: string | null }
      | undefined;
    return row?.agent_output_json === null || row?.agent_output_json === undefined
      ? undefined
      : (JSON.parse(row.agent_output_json) as SynapseMessage);
  } finally {
    database.close();
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

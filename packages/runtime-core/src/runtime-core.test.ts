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
import { textMessage, type MessageSegment, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import {
  buildSourceEventId,
  InMemoryEventProcessStore,
  InMemoryTranscriptStore,
  RuntimeCore,
  SqliteRuntimeContextStore,
  WorkspaceResolverLite,
  type EventProcessBeginInput,
  type EventProcessState,
  type IdentityResolver,
  type TranscriptAppendInput
} from "./index.js";

class MockChannelAdapter implements ChannelAdapter {
  readonly id = "qq-local";
  readonly type = "onebot11";
  readonly provider = "napcat";
  readonly #handlers = new Set<ChannelEventHandler>();
  readonly sent: Array<{ target: ChannelTarget; message: SynapseMessage }> = [];
  readonly sendResults: SendResult[] = [];

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
    return this.sendResults.shift() ?? { ok: true, messageId: "sent-1" };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async emit(event: SynapseChannelEvent): Promise<void> {
    await Promise.all([...this.#handlers].map((handler) => handler(event)));
  }
}

class FailFirstAssistantTranscriptStore extends InMemoryTranscriptStore {
  #failed = false;

  override async append(input: TranscriptAppendInput) {
    if (input.role === "assistant" && !this.#failed) {
      this.#failed = true;
      throw new Error("transcript write failed");
    }

    return super.append(input);
  }
}

class RecordingTranscriptStore extends InMemoryTranscriptStore {
  readonly appends: TranscriptAppendInput[] = [];

  override async append(input: TranscriptAppendInput) {
    this.appends.push(input);
    return super.append(input);
  }
}

class RecordingEventProcessStore extends InMemoryEventProcessStore {
  readonly begins: EventProcessBeginInput[] = [];
  readonly updates: Array<{ id: string; status: EventProcessState["status"] | undefined }> = [];

  override async begin(input: EventProcessBeginInput): Promise<EventProcessState> {
    this.begins.push(input);
    return super.begin(input);
  }

  override async update(
    id: string,
    patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>
  ): Promise<EventProcessState> {
    this.updates.push({ id, status: patch.status });
    return super.update(id, patch);
  }
}

class FailingEventProcessStore extends InMemoryEventProcessStore {
  override async begin(): Promise<EventProcessState> {
    throw new Error("idempotency unavailable");
  }
}

const failingIdentityResolver: IdentityResolver = {
  async resolve() {
    throw new Error("identity unavailable");
  }
};

describe("RuntimeCore", () => {
  it("persists transcript and event process state in SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-sqlite-"));
    const databasePath = join(dir, "runtime-context.sqlite");

    try {
      const store = new SqliteRuntimeContextStore({ databasePath });
      const input: TranscriptAppendInput = {
        sessionId: "qq:napcat:qq-local:private:user-1",
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1",
        role: "user",
        actorId: "guest:qq:napcat:qq-local:user-1",
        text: "hello",
        createdAt: new Date(0).toISOString()
      };
      const first = await store.append(input);
      const duplicate = await store.append({ ...input, text: "ignored duplicate" });
      const { actorId: _actorId, ...assistantInput } = input;
      await store.append({
        ...assistantInput,
        sourceEventId: "event-2",
        role: "assistant",
        text: "reply",
        createdAt: new Date(1).toISOString()
      });
      const state = await store.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1"
      });
      const updated = await store.update(state.id, {
        status: "agent_completed",
        incomingMessageId: first.id,
        agentOutputText: "reply"
      });
      store.close();

      const reopened = new SqliteRuntimeContextStore({ databasePath });
      const recent = await reopened.listRecent(input.sessionId, { limit: 10 });
      const recovered = await reopened.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1"
      });

      expect(duplicate).toEqual(first);
      expect(recent.map((message) => message.text)).toEqual(["hello", "reply"]);
      expect(updated.status).toBe("agent_completed");
      expect(recovered.status).toBe("agent_completed");
      expect(recovered.agentOutputText).toBe("reply");
      reopened.close();

      const db = new Database(databasePath);
      db.prepare(`
        INSERT INTO workspaces (id, type, name, created_at, updated_at)
        VALUES ('workspace-1', 'personal', 'Workspace 1', ?, ?)
      `).run(new Date(0).toISOString(), new Date(0).toISOString());
      expect(() => db.prepare(`
        INSERT INTO workspace_bindings (
          id,
          workspace_id,
          binding_type,
          identity_id,
          platform,
          created_at
        ) VALUES ('binding-invalid', 'workspace-1', 'identity', 'identity-1', 'qq', ?)
      `).run(new Date(0).toISOString())).toThrow();
      db.prepare(`
        INSERT INTO workspace_bindings (
          id,
          workspace_id,
          binding_type,
          identity_id,
          created_at
        ) VALUES ('binding-1', 'workspace-1', 'identity', 'identity-1', ?)
      `).run(new Date(0).toISOString());
      expect(db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_records'
      `).get()).toEqual({ name: "memory_records" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes channel events through conversation policy before invoking the agent", async () => {
    const channel = new MockChannelAdapter();
    const toolRuntime = new ToolRuntime(
      new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })
    );
    const runs: AgentRun[] = [];
    const agent: Agent = {
      id: "echo-agent",
      async run(request): Promise<AgentRun> {
        const run = {
          id: "run-1",
          agentId: "echo-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        } satisfies AgentRun;
        runs.push(run);
        return run;
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "keyword", keywords: ["Synapse"] },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: toolRuntime
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "hello"));
    await channel.emit(groupMessage("event-2", "Synapse ping"));

    expect(runs).toHaveLength(1);
    expect(channel.sent).toEqual([
      {
        target: { type: "group", groupId: "group-1" },
        message: {
          ...textMessage("ok"),
          replyTo: {
            eventId: "event-2"
          }
        }
      }
    ]);
    expect(runtime.traces).toEqual([
      { eventId: "event-1", status: "ignored", reason: "not_triggered" },
      { eventId: "event-2", status: "succeeded", runId: "run-1" }
    ]);
  });

  it("blocks channel replies when the send permission is not allowed", async () => {
    const channel = new MockChannelAdapter();
    const agent: Agent = {
      id: "echo-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "echo-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "confirm" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "Synapse ping"));

    expect(channel.sent).toEqual([]);
    expect(runtime.traces).toEqual([
      {
        eventId: "event-1",
        status: "blocked",
        reason: 'Permission decision was "confirm".',
        runId: "run-1"
      }
    ]);
  });

  it("composes recent private history into the second agent request", async () => {
    const channel = new MockChannelAdapter();
    const observedHistory: number[] = [];
    const agent: Agent = {
      id: "history-agent",
      async run(request): Promise<AgentRun> {
        observedHistory.push(request.promptContext?.messages.length ?? 0);
        return {
          id: `run-${request.event.id}`,
          agentId: "history-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage(`reply-${request.event.id}`)
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "first"));
    await channel.emit(privateMessage("event-2", "second"));

    expect(observedHistory).toEqual([0, 2]);
    expect(channel.sent.map((sent) => sent.message.segments[0])).toEqual([
      { type: "text", text: "reply-event-1" },
      { type: "text", text: "reply-event-2" }
    ]);
  });

  it("does not call the agent again for completed duplicate source events", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "dedupe-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${request.event.id}-${runCount}`,
          agentId: "dedupe-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });
    const event = groupMessage("event-1", "Synapse ping");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);

    expect(runCount).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(runtime.traces.at(-1)).toEqual({ eventId: "event-1", status: "ignored", reason: "duplicate_completed" });
  });

  it("does not call the agent again for completed duplicate source events after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-restart-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    let runCount = 0;
    const agent: Agent = {
      id: "sqlite-dedupe-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${runCount}`,
          agentId: "sqlite-dedupe-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };

    try {
      const firstChannel = new MockChannelAdapter();
      const firstStore = new SqliteRuntimeContextStore({ databasePath });
      const firstRuntime = new RuntimeCore({
        channels: new InMemoryChannelRegistry(),
        conversation: new ConversationRouter({
          groupTrigger: { mode: "always" },
          privateTrigger: { mode: "always" }
        }),
        agent,
        tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
        context: {
          providerByChannelId: { "qq-local": "napcat" },
          transcriptStore: firstStore,
          eventProcessStore: firstStore
        }
      });
      const event = privateMessage("event-1", "hello");

      firstRuntime.attachChannel(firstChannel);
      await firstChannel.emit(event);
      firstStore.close();

      const secondChannel = new MockChannelAdapter();
      const secondStore = new SqliteRuntimeContextStore({ databasePath });
      const secondRuntime = new RuntimeCore({
        channels: new InMemoryChannelRegistry(),
        conversation: new ConversationRouter({
          groupTrigger: { mode: "always" },
          privateTrigger: { mode: "always" }
        }),
        agent,
        tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
        context: {
          providerByChannelId: { "qq-local": "napcat" },
          transcriptStore: secondStore,
          eventProcessStore: secondStore
        }
      });

      secondRuntime.attachChannel(secondChannel);
      await secondChannel.emit(event);

      expect(runCount).toBe(1);
      expect(firstChannel.sent).toHaveLength(1);
      expect(secondChannel.sent).toHaveLength(0);
      expect(secondRuntime.traces).toEqual([
        { eventId: "event-1", status: "ignored", reason: "duplicate_completed" }
      ]);
      secondStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the injected event process store for idempotency state", async () => {
    const channel = new MockChannelAdapter();
    const eventProcessStore = new RecordingEventProcessStore();
    const agent: Agent = {
      id: "event-process-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "event-process-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" }, eventProcessStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(eventProcessStore.begins).toEqual([
      {
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1"
      }
    ]);
    expect(eventProcessStore.updates.map((update) => update.status)).toEqual([
      "processing",
      "agent_completed",
      undefined,
      "send_succeeded",
      "completed"
    ]);
  });

  it("uses a best-effort source event id for generated wall-clock event ids", async () => {
    const first = {
      ...privateMessage("qq-local:message:private:1700000000000", "hello"),
      message: textMessage("hello")
    };
    const duplicate = {
      ...first,
      id: "qq-local:message:private:1700000000001"
    };

    expect(buildSourceEventId(first, "napcat")).toEqual(buildSourceEventId(duplicate, "napcat"));
    expect(buildSourceEventId(first, "napcat")).toMatch(/^best-effort:/);
  });

  it("deduplicates generated wall-clock source event ids with best-effort hashing", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "best-effort-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${runCount}`,
          agentId: "best-effort-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });
    const first = {
      ...privateMessage("qq-local:message:private:1700000000000", "hello"),
      message: textMessage("hello")
    };
    const duplicate = {
      ...first,
      id: "qq-local:message:private:1700000000001"
    };

    runtime.attachChannel(channel);
    await channel.emit(first);
    await channel.emit(duplicate);

    expect(runCount).toBe(1);
    expect(channel.sent).toHaveLength(1);
  });

  it("does not write transcript for untriggered group messages", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    const agent: Agent = {
      id: "unused-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "unused-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("unused")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "keyword", keywords: ["Synapse"] },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "ordinary group message"));

    expect(transcriptStore.appends).toEqual([]);
    expect(channel.sent).toEqual([]);
  });

  it("does not trigger or persist group messages that mention someone else or everyone", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    let runCount = 0;
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention", botUserIds: ["bot-1"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "mention-agent",
        async run(request): Promise<AgentRun> {
          runCount += 1;
          return {
            id: `run-${request.event.id}`,
            agentId: "mention-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessageWithSegments("event-other", [
      { type: "mention", target: "user", userId: "user-2" },
      { type: "text", text: " hi" }
    ]));
    await channel.emit(groupMessageWithSegments("event-all", [
      { type: "mention", target: "all" },
      { type: "text", text: " hi" }
    ]));

    expect(runCount).toBe(0);
    expect(transcriptStore.appends).toEqual([]);
    expect(runtime.traces).toEqual([
      { eventId: "event-other", status: "ignored", reason: "mentioned_other_user" },
      { eventId: "event-all", status: "ignored", reason: "mention_all" }
    ]);
  });

  it("triggers group mention only when the mentioned user is the bot", async () => {
    const channel = new MockChannelAdapter();
    const observedReasons: string[] = [];
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention", botUserIds: ["bot-1"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "mention-bot-agent",
        async run(request): Promise<AgentRun> {
          observedReasons.push(request.trigger?.reason ?? "missing");
          return {
            id: "run-1",
            agentId: "mention-bot-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessageWithSegments("event-bot", [
      { type: "mention", target: "user", userId: "bot-1" },
      { type: "text", text: " hi" }
    ]));

    expect(observedReasons).toEqual(["mentioned_bot"]);
    expect(channel.sent).toHaveLength(1);
  });

  it("triggers reply_to_bot by matching normalized external message ids", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    await transcriptStore.append({
      sessionId: "qq:unknown:qq-local:group:group-1",
      platform: "qq",
      provider: "unknown",
      channelId: "qq-local",
      conversationType: "group",
      conversationId: "group-1",
      sourceEventId: "assistant-1",
      role: "assistant",
      text: "previous bot reply",
      externalMessageId: "42",
      createdAt: new Date(0).toISOString()
    });
    const observedReasons: string[] = [];
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention", botUserIds: ["bot-1"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "reply-agent",
        async run(request): Promise<AgentRun> {
          observedReasons.push(request.trigger?.reason ?? "missing");
          return {
            id: "run-1",
            agentId: "reply-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore }
    });

    runtime.attachChannel(channel);
    await channel.emit({
      ...groupMessage("event-reply", "continue"),
      message: { ...textMessage("continue"), replyTo: { messageId: "42" } },
      adapterCapabilities: { replyToBot: "yes", incomingReplyTarget: true }
    });

    expect(observedReasons).toEqual(["reply_to_bot"]);
    expect(channel.sent).toHaveLength(1);
  });

  it("filters prompt history by conversation TTL", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    await transcriptStore.append({
      sessionId: "qq:unknown:qq-local:private:user-1",
      platform: "qq",
      provider: "unknown",
      channelId: "qq-local",
      conversationType: "private",
      conversationId: "user-1",
      sourceEventId: "old-message",
      role: "user",
      actorId: "guest:qq:unknown:qq-local:user-1",
      text: "old topic",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const observedHistory: string[][] = [];
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention" },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "ttl-agent",
        async run(request): Promise<AgentRun> {
          observedHistory.push(request.promptContext?.messages.map((message) => message.content) ?? []);
          return {
            id: "run-1",
            agentId: "ttl-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { transcriptStore, privateHistoryTtlMinutes: 30 }
    });

    runtime.attachChannel(channel);
    await channel.emit({ ...privateMessage("event-ttl", "hi"), receivedAt: "2026-07-05T00:00:00.000Z" });

    expect(observedHistory).toEqual([[]]);
  });

  it("marks command triggers as single-turn by default", () => {
    const router = new ConversationRouter({
      groupTrigger: { mode: "mention_or_keyword", commandPrefixes: ["/"], allowCommandWithoutMention: true },
      privateTrigger: { mode: "always", commandPrefixes: ["/"] },
      contextPolicy: { includeHistory: true, maxMessages: 20 }
    });

    const decision = router.route(privateMessage("event-command", "/whoami"));

    expect(decision.reason).toBe("command_prefix");
    expect(decision.request?.contextPolicy.includeHistory).toBe(false);
    expect(decision.request?.trigger).toEqual({
      kind: "command",
      confidence: "explicit",
      reason: "command_prefix"
    });
  });

  it("falls back to a guest actor when identity resolution fails", async () => {
    const channel = new MockChannelAdapter();
    const observedUserIds: string[] = [];
    const agent: Agent = {
      id: "identity-fallback-agent",
      async run(request): Promise<AgentRun> {
        observedUserIds.push(request.userId);
        return {
          id: "run-1",
          agentId: "identity-fallback-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" }, identityResolver: failingIdentityResolver }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(observedUserIds).toEqual(["guest:qq:napcat:qq-local:user-1"]);
    expect(channel.sent).toHaveLength(1);
  });

  it("falls back to the default workspace when workspace resolution fails", async () => {
    const channel = new MockChannelAdapter();
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "unused-agent",
        async run(): Promise<AgentRun> {
          throw new Error("agent should not be called");
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: {
        providerByChannelId: { "qq-local": "napcat" },
        workspaceResolver: {
          async resolve() {
            throw new Error("workspace unavailable");
          }
        }
      }
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "/workspace info"));

    expect(sentText(channel.sent[0]?.message)).toContain("workspaceId=group:qq:qq-local:group-1");
  });

  it("continues without idempotency recovery when event process begin fails", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "no-idempotency-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: "run-1",
          agentId: "no-idempotency-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { eventProcessStore: new FailingEventProcessStore() }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(runCount).toBe(1);
    expect(channel.sent).toHaveLength(1);
  });

  it("resolves an existing workspace conversation binding from SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-workspace-"));
    const databasePath = join(dir, "runtime-context.sqlite");

    try {
      const store = new SqliteRuntimeContextStore({ databasePath });
      const db = new Database(databasePath);
      db.prepare(`
        INSERT INTO workspaces (id, type, name, created_at, updated_at)
        VALUES ('custom-group-workspace', 'group', 'Custom Group', ?, ?)
      `).run(new Date(0).toISOString(), new Date(0).toISOString());
      db.prepare(`
        INSERT INTO workspace_bindings (
          id,
          workspace_id,
          binding_type,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          created_at
        ) VALUES ('binding-1', 'custom-group-workspace', 'conversation', 'qq', 'napcat', 'qq-local', 'group', 'group-1', ?)
      `).run(new Date(0).toISOString());
      db.close();

      const resolver = new WorkspaceResolverLite({ workspaceStore: store });
      const workspace = await resolver.resolve(groupMessage("event-1", "hello"), {
        identity: {
          id: "guest:qq:napcat:qq-local:user-1",
          type: "guest",
          trustLevel: "guest",
          roles: []
        },
        platformIdentity: {
          platform: "qq",
          provider: "napcat",
          channelId: "qq-local",
          platformUserId: "user-1"
        },
        isBound: false
      });

      expect(workspace).toEqual({ id: "custom-group-workspace", type: "group", name: "Custom Group" });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a send_failed duplicate without calling the agent again", async () => {
    const channel = new MockChannelAdapter();
    channel.sendResults.push({ ok: false, error: "network down" }, { ok: true, messageId: "sent-2" });
    let runCount = 0;
    const agent: Agent = {
      id: "retry-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${runCount}`,
          agentId: "retry-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("retry me")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });
    const event = groupMessage("event-1", "Synapse ping");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);

    expect(runCount).toBe(1);
    expect(channel.sent).toHaveLength(2);
    expect(runtime.traces).toEqual([
      { eventId: "event-1", status: "failed", reason: "network down", runId: "run-1" },
      { eventId: "event-1", status: "succeeded", runId: "recovered-event-1" }
    ]);
  });

  it("fills missing assistant transcript after send_succeeded without resending", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new FailFirstAssistantTranscriptStore();
    let runCount = 0;
    const observedHistory: string[][] = [];
    const agent: Agent = {
      id: "recover-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        observedHistory.push(request.promptContext?.messages.map((message) => message.content) ?? []);
        return {
          id: `run-${request.event.id}`,
          agentId: "recover-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage(`reply-${request.event.id}`)
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" }, transcriptStore }
    });
    const event = privateMessage("event-1", "first");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);
    await channel.emit(privateMessage("event-2", "second"));

    expect(runCount).toBe(2);
    expect(channel.sent).toHaveLength(2);
    expect(observedHistory[0]).toEqual([]);
    expect(observedHistory[1]?.[0]).toBe("[1970-01-01T00:00:00.000Z] first");
    expect(observedHistory[1]?.[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] reply-event-1$/);
  });

  it("applies concise response policy in group workspaces", async () => {
    const channel = new MockChannelAdapter();
    const agent: Agent = {
      id: "long-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "long-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage(`# Title\n\n**${"x".repeat(700)}**\n\n\`\`\`ts\nconsole.log("hidden")\n\`\`\``)
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "Synapse ping"));

    const text = sentText(channel.sent[0]?.message);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toContain("```");
    expect(text).not.toContain("**");
    expect(text).toContain("内容较长，需要我展开再说。");
  });

  it("handles workspace info without invoking the agent", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "unused-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: "run-1",
          agentId: "unused-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("unused")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "/workspace info"));

    expect(runCount).toBe(0);
    expect(channel.sent[0]?.message.segments[0]).toEqual({
      type: "text",
      text: expect.stringContaining("workspaceType=personal")
    });
  });

  it("returns a disabled durable memory message by default", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "unused-agent",
        async run(): Promise<AgentRun> {
          runCount += 1;
          throw new Error("agent should not be called");
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "/memory remember 我喜欢简短回答"));

    expect(runCount).toBe(0);
    expect(channel.sent[0]?.message.segments[0]).toEqual({
      type: "text",
      text: "当前未启用长期记忆。你的消息只会作为当前会话历史使用。"
    });
  });
});

function groupMessage(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "group-1", kind: "group" },
    sender: { id: "user-1" },
    message: textMessage(text),
    raw: {},
    receivedAt: new Date(0).toISOString()
  };
}

function groupMessageWithSegments(id: string, segments: readonly MessageSegment[]): SynapseChannelEvent {
  return {
    ...groupMessage(id, ""),
    message: {
      type: "mixed",
      segments
    }
  };
}

function privateMessage(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "user-1", kind: "private" },
    sender: { id: "user-1" },
    message: textMessage(text, id),
    raw: {},
    receivedAt: new Date(0).toISOString()
  };
}

function sentText(message: SynapseMessage | undefined): string {
  return (
    message?.segments
      .filter((segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text")
      .map((segment) => segment.text)
      .join("") ?? ""
  );
}

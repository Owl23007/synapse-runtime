import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { onTestFinished, describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";

import { textMessage } from "@synapse/runtime-protocol";

import { SqliteRuntimeContextStore, WorkspaceResolverLite, type TranscriptAppendInput } from "../../src/index.js";
import { createRuntimeFixture, MockChannelAdapter, groupMessage, privateMessage } from "../helpers/runtime.js";
describe("RuntimeCore SQLite 持久化与重启", () => {
  it("在 SQLite 中持久保存转录与事件处理状态", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-sqlite-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = join(dir, "runtime-context.sqlite");

    {
      const store = new SqliteRuntimeContextStore({ databasePath });
      onTestFinished(() => store.close());
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
        sourceEventId: "event-1",
        sourceEventType: "message.created"
      });
      const [firstClaim, duplicateClaim] = await Promise.all([
        store.claim(state.id, {
          expectedStatus: state.status,
          expectedUpdatedAt: state.updatedAt
        }),
        store.claim(state.id, {
          expectedStatus: state.status,
          expectedUpdatedAt: state.updatedAt
        })
      ]);
      const updated = await store.update(state.id, {
        status: "agent_completed",
        incomingMessageId: first.id,
        agentOutputText: "reply"
      });
      store.close();

      const reopened = new SqliteRuntimeContextStore({ databasePath });
      onTestFinished(() => reopened.close());
      const recent = await reopened.listRecent(input.sessionId, { limit: 10 });
      const recovered = await reopened.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1",
        sourceEventType: "message.created"
      });
      const distinctEventType = await reopened.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1",
        sourceEventType: "message.deleted"
      });

      expect(duplicate).toEqual(first);
      expect(Number(firstClaim.claimed) + Number(duplicateClaim.claimed)).toBe(1);
      expect(recent.map((message) => message.text)).toEqual(["hello", "reply"]);
      expect(updated.status).toBe("agent_completed");
      expect(recovered.status).toBe("agent_completed");
      expect(recovered.agentOutputText).toBe("reply");
      expect(distinctEventType).toMatchObject({ status: "received" });
      expect(distinctEventType.id).not.toBe(recovered.id);
      reopened.close();

      const db = new Database(databasePath);
      onTestFinished(() => {
        if (db.open) db.close();
      });
      db.prepare(`
        INSERT INTO workspaces (id, type, name, created_at, updated_at)
        VALUES ('workspace-1', 'personal', 'Workspace 1', ?, ?)
      `).run(new Date(0).toISOString(), new Date(0).toISOString());
      expect(() =>
        db
          .prepare(`
        INSERT INTO workspace_bindings (
          id,
          workspace_id,
          binding_type,
          identity_id,
          platform,
          created_at
        ) VALUES ('binding-invalid', 'workspace-1', 'identity', 'identity-1', 'qq', ?)
      `)
          .run(new Date(0).toISOString())
      ).toThrow();
      db.prepare(`
        INSERT INTO workspace_bindings (
          id,
          workspace_id,
          binding_type,
          identity_id,
          created_at
        ) VALUES ('binding-1', 'workspace-1', 'identity', 'identity-1', ?)
      `).run(new Date(0).toISOString());
      expect(
        db
          .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_records'
      `)
          .get()
      ).toEqual({ name: "memory_records" });
      db.close();
    }
  });

  it("重启后已完成的重复源事件不再调用代理", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-restart-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = join(dir, "runtime-context.sqlite");
    let runCount = 0;
    let firstStore: SqliteRuntimeContextStore | undefined;
    let secondStore: SqliteRuntimeContextStore | undefined;
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

    {
      const firstChannel = new MockChannelAdapter();
      firstStore = new SqliteRuntimeContextStore({ databasePath });
      onTestFinished(firstStore.close.bind(firstStore));
      const firstRuntime = createRuntimeFixture({
        agent,
        context: {
          providerByChannelId: { "qq-local": "napcat" },
          transcriptStore: firstStore,
          eventProcessStore: firstStore
        }
      });
      const event = privateMessage("event-1", "hello");

      firstRuntime.attachChannel(firstChannel);
      await firstChannel.emit(event);
      await firstRuntime.dispose();
      firstStore.close();
      firstStore = undefined;

      const secondChannel = new MockChannelAdapter();
      secondStore = new SqliteRuntimeContextStore({ databasePath });
      onTestFinished(secondStore.close.bind(secondStore));
      const secondRuntime = createRuntimeFixture({
        agent,
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
      expect(secondRuntime.traces).toEqual([{ eventId: "event-1", status: "ignored", reason: "duplicate_completed" }]);
    }
  });

  it("从 SQLite 解析已有工作区会话绑定", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-workspace-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = join(dir, "runtime-context.sqlite");

    {
      const store = new SqliteRuntimeContextStore({ databasePath });
      onTestFinished(() => store.close());
      const db = new Database(databasePath);
      onTestFinished(() => {
        if (db.open) db.close();
      });
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
    }
  });
});

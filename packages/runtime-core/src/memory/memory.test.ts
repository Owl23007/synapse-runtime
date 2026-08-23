import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTextContent, textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { commandResponse } from "../commands/command-response.js";
import { InMemoryConversationStore } from "../conversation/in-memory.js";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import { InMemoryMemoryStore } from "./in-memory.js";
import type { RuntimeActor, WorkspaceRef } from "../context/types.js";
import { IdentityResolverLite } from "../context/identity.js";
import { InMemoryWorkspaceStore } from "../context/workspace.js";
import { promoteExplicitMemory } from "./promotion.js";

const actor: RuntimeActor = {
  identity: { id: "identity:alice", type: "guest", trustLevel: "guest", roles: [] },
  platformIdentity: {
    platform: "qq",
    provider: "napcat",
    channelId: "qq-local",
    platformUserId: "alice"
  },
  isBound: false
};

const privateWorkspace: WorkspaceRef = { id: "personal:identity:alice", type: "personal", name: "Alice" };
const groupWorkspace: WorkspaceRef = { id: "group:qq:qq-local:group-1", type: "group", name: "Group" };

function memoryCommandEvent(text: string, id: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "alice", kind: "private" },
    sender: { id: "alice" },
    message: textMessage(text),
    receivedAt: new Date(0).toISOString()
  };
}

function cleanupTempDirectory(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    // Windows 测试进程偶尔会延迟释放 SQLite WAL 文件，不影响已关闭连接的持久化断言
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
}

describe("MemoryStore", () => {
  it("隔离身份记忆与群组记忆，并支持软删除", async () => {
    const store = new InMemoryMemoryStore();
    const privateRecord = await store.remember({
      scopeType: "identity",
      scopeId: actor.identity.id,
      identityId: actor.identity.id,
      visibility: "private",
      content: "我喜欢简短回答",
      source: "test",
      idempotencyKey: "private-1"
    });
    await store.remember({
      scopeType: "workspace",
      scopeId: groupWorkspace.id,
      workspaceId: groupWorkspace.id,
      visibility: "workspace",
      content: "本群默认短答",
      source: "test",
      idempotencyKey: "group-1"
    });

    expect(
      (
        await store.list({
          identityId: actor.identity.id,
          workspaceId: groupWorkspace.id,
          workspaceType: "group"
        })
      ).map((record) => record.content)
    ).toEqual(["本群默认短答"]);
    expect(
      (
        await store.list({
          identityId: actor.identity.id,
          workspaceId: privateWorkspace.id,
          workspaceType: "personal"
        })
      ).map((record) => record.content)
    ).toEqual(["我喜欢简短回答"]);
    expect(
      await store.delete(privateRecord.id, {
        identityId: actor.identity.id,
        workspaceId: privateWorkspace.id,
        workspaceType: "personal",
        idempotencyKey: "delete-1"
      })
    ).toBe(true);
    expect(
      await store.list({
        identityId: actor.identity.id,
        workspaceId: privateWorkspace.id,
        workspaceType: "personal"
      })
    ).toHaveLength(0);
  });

  it("通过 SQLite 闭环持久化并恢复长期记忆", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-memory-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    try {
      const first = new SqliteRuntimeContextStore({ databasePath });
      await first.resolveWorkspace({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "group",
        conversationId: "group-1",
        identityId: actor.identity.id,
        defaultWorkspace: groupWorkspace
      });
      const created = await first.remember({
        scopeType: "workspace",
        scopeId: groupWorkspace.id,
        workspaceId: groupWorkspace.id,
        visibility: "workspace",
        content: "持久化设置",
        source: "test",
        sourceEventId: "memory-event-1",
        idempotencyKey: "memory-write-1"
      });
      const duplicate = await first.remember({
        scopeType: "workspace",
        scopeId: groupWorkspace.id,
        workspaceId: groupWorkspace.id,
        visibility: "workspace",
        content: "不同内容",
        source: "test",
        sourceEventId: "memory-event-1",
        idempotencyKey: "memory-write-2"
      });
      expect(duplicate).toEqual(created);
      first.close();

      const reopened = new SqliteRuntimeContextStore({ databasePath });
      await expect(
        reopened.list({
          identityId: actor.identity.id,
          workspaceId: groupWorkspace.id,
          workspaceType: "group"
        })
      ).resolves.toMatchObject([{ id: created.id, content: "持久化设置" }]);
      reopened.close();
    } finally {
      cleanupTempDirectory(dir);
    }
  });

  it("重复删除使用同一个幂等键时保持第一次结果", async () => {
    const store = new InMemoryMemoryStore();
    const record = await store.remember({
      scopeType: "identity",
      scopeId: actor.identity.id,
      identityId: actor.identity.id,
      visibility: "private",
      content: "一次性偏好",
      source: "test",
      idempotencyKey: "delete-idempotency-record"
    });
    const input = {
      identityId: actor.identity.id,
      workspaceId: privateWorkspace.id,
      workspaceType: "personal" as const,
      idempotencyKey: "delete-idempotency"
    };
    expect(await store.delete(record.id, input)).toBe(true);
    expect(await store.delete(record.id, input)).toBe(true);
  });

  it("在访问范围内按关键词检索并按相关性排序", async () => {
    const store = new InMemoryMemoryStore();
    await store.remember({
      scopeType: "identity",
      scopeId: actor.identity.id,
      identityId: actor.identity.id,
      visibility: "private",
      content: "偏好简短回答",
      source: "test",
      importance: 0.9,
      idempotencyKey: "search-1"
    });
    await store.remember({
      scopeType: "identity",
      scopeId: actor.identity.id,
      identityId: actor.identity.id,
      visibility: "private",
      content: "偏好回答使用 Markdown",
      source: "test",
      idempotencyKey: "search-2"
    });
    const results = await store.search({
      query: "偏好 简短",
      identityId: actor.identity.id,
      workspaceId: privateWorkspace.id,
      workspaceType: "personal"
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.record.content).toBe("偏好简短回答");
  });

  it("只将明确的记住请求自动晋升为幂等事实记忆", async () => {
    const store = new InMemoryMemoryStore();
    const input = {
      message: textMessage("请记住：我使用简短回答"),
      actor,
      workspace: privateWorkspace,
      sourceEventId: "promotion-1"
    };
    const first = await promoteExplicitMemory(store, input);
    const duplicate = await promoteExplicitMemory(store, input);
    expect(first?.content).toBe("我使用简短回答");
    expect(duplicate).toEqual(first);
    await expect(
      promoteExplicitMemory(store, {
        ...input,
        message: textMessage("普通消息")
      })
    ).resolves.toBeUndefined();
  });

  it("可以将身份切换到可复用的项目工作区", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.bindProjectWorkspace({ workspaceId: "project:synapse", identityId: actor.identity.id });
    await expect(
      store.resolveWorkspace({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "alice",
        identityId: actor.identity.id,
        defaultWorkspace: privateWorkspace
      })
    ).resolves.toEqual({ id: "project:synapse", type: "project", name: "project:synapse" });
  });

  it("持久化平台身份映射并恢复稳定身份", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-identity-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    try {
      const first = new SqliteRuntimeContextStore({ databasePath });
      const resolver = new IdentityResolverLite({ identityStore: first });
      const event = memoryCommandEvent("hello", "identity-event");
      const initial = await resolver.resolve(event, "napcat");
      first.close();

      const reopened = new SqliteRuntimeContextStore({ databasePath });
      const restored = await new IdentityResolverLite({ identityStore: reopened }).resolve(event, "napcat");
      expect(restored.identity).toEqual(initial.identity);
      expect(restored.isBound).toBe(false);
      reopened.close();
    } finally {
      cleanupTempDirectory(dir);
    }
  });

  it("通过内置命令写入、列出并删除记忆", async () => {
    const store = new InMemoryMemoryStore();
    const conversation = new InMemoryConversationStore();
    const written = await commandResponse(
      memoryCommandEvent("/memory remember 我喜欢短答", "command-1"),
      actor,
      privateWorkspace,
      "session-1",
      conversation,
      {
        enableDurableMemory: true,
        memoryStore: store,
        sourceEventId: "command-1"
      }
    );
    expect(getTextContent(written!)).toContain("私人偏好");
    const listed = await commandResponse(
      memoryCommandEvent("/memory list", "command-2"),
      actor,
      privateWorkspace,
      "session-1",
      conversation,
      {
        enableDurableMemory: true,
        memoryStore: store,
        sourceEventId: "command-2"
      }
    );
    expect(getTextContent(listed!)).toContain("我喜欢短答");
    const id = (
      await store.list({ identityId: actor.identity.id, workspaceId: privateWorkspace.id, workspaceType: "personal" })
    )[0]!.id;
    const deleted = await commandResponse(
      memoryCommandEvent(`/memory delete ${id}`, "command-3"),
      actor,
      privateWorkspace,
      "session-1",
      conversation,
      {
        enableDurableMemory: true,
        memoryStore: store,
        sourceEventId: "command-3"
      }
    );
    expect(getTextContent(deleted!)).toContain("已删除");
  });
});

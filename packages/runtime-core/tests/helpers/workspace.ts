import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { SqliteRuntimeContextStore } from "../../src/storage/sqlite/runtime-context-store.js";

/** 创建两个隔离工作区，数据库与临时目录始终归当前用例所有 */
export async function createWorkspaceStoreFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRuntimeContextStore({ databasePath: join(root, "runtime.sqlite") });
  // 按取得资源的反向顺序执行结束钩子，先关闭数据库再删除目录
  onTestFinished(() => store.close());
  for (const id of ["a", "b"]) {
    await store.resolveWorkspace({
      platform: "qq",
      provider: "napcat",
      channelId: "qq",
      conversationType: "group",
      conversationId: id,
      identityId: "actor",
      defaultWorkspace: { id, type: "group", name: id }
    });
  }
  return { root, store };
}

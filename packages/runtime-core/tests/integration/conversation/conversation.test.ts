import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import {
  registerConversationStoreContract,
  type ConversationStoreContractHarness
} from "../../contracts/conversation-store.contract.js";
import { InMemoryConversationStore } from "../../../src/conversation/in-memory.js";

registerConversationStoreContract("in-memory", () => ({
  store: new InMemoryConversationStore(),
  close: () => undefined
}));

registerConversationStoreContract("sqlite", createSqliteHarness);

/** 创建带独立临时数据库的 SQLite 契约测试环境 */
function createSqliteHarness(): ConversationStoreContractHarness {
  const directory = mkdtempSync(join(tmpdir(), "synapse-conversation-contract-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteRuntimeContextStore({
    databasePath: join(directory, "runtime-context.sqlite")
  });
  onTestFinished(() => store.close());

  return {
    store,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import {
  registerConversationStoreContract,
  type ConversationStoreContractHarness
} from "./contract/conversation-store.contract.js";
import { InMemoryConversationStore } from "./in-memory.js";

registerConversationStoreContract("in-memory", () => ({
  store: new InMemoryConversationStore(),
  close: () => undefined
}));

registerConversationStoreContract("sqlite", createSqliteHarness);

/** 创建带独立临时数据库的 SQLite 契约测试环境 */
function createSqliteHarness(): ConversationStoreContractHarness {
  const directory = mkdtempSync(join(tmpdir(), "synapse-conversation-contract-"));
  const store = new SqliteRuntimeContextStore({
    databasePath: join(directory, "runtime-context.sqlite")
  });

  return {
    store,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

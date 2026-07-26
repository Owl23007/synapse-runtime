import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { parseConfigObject } from "@synapse/runtime-config";
import { describe, expect, it } from "vitest";
import { createRuntimeFromConfig } from "./runtime-factory.js";

describe("createRuntimeFromConfig", () => {
  it("keeps the SQLite runtime store durable when prompt context is disabled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-runtime-factory-context-disabled-"));
    const databasePath = join(dataDir, "runtime-context.sqlite");
    const config = parseConfigObject({
      runtime: { dataDir },
      context: { enabled: false }
    });

    try {
      const first = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: silentLogger
      });
      const state = await first.contextStore.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1",
        sourceEventType: "message.created"
      });
      await first.contextStore.update(state.id, { status: "processing" });
      first.contextStore.close();

      expect(existsSync(databasePath)).toBe(true);

      const second = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: silentLogger
      });

      try {
        await expect(
          second.contextStore.begin({
            platform: "qq",
            provider: "napcat",
            channelId: "qq-local",
            conversationType: "private",
            conversationId: "user-1",
            sourceEventId: "event-1",
            sourceEventType: "message.created"
          })
        ).resolves.toMatchObject({ id: state.id, status: "processing" });
      } finally {
        second.contextStore.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

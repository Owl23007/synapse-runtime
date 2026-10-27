import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { describe, expect, it, vi } from "vitest";
import { parseConfigObject } from "../config/index.js";
import { createRuntimeAssembly } from "./runtime-assembly.js";

const logger = { info() {}, warn() {}, error() {} };

describe("RuntimeAssembly resource ownership", () => {
  it("holds the SQLite lease until runtime and task shutdown finish and disposes once", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-assembly-"));
    const create = () =>
      createRuntimeAssembly({
        config: parseConfigObject({ runtime: { dataDir } }),
        channels: new InMemoryChannelRegistry(),
        logger
      });
    const assembly = create();
    const close = vi.spyOn(assembly.contextStore, "close");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disposeRuntime = assembly.runtime.dispose.bind(assembly.runtime);
    vi.spyOn(assembly.runtime, "dispose").mockImplementation(async () => {
      await pending;
      await disposeRuntime();
    });
    const tasks = vi.spyOn(assembly.taskRunner, "dispose");
    try {
      const first = assembly.dispose();
      expect(assembly.dispose()).toBe(first);
      expect(close).not.toHaveBeenCalled();
      expect(tasks).not.toHaveBeenCalled();
      expect(() => create()).toThrow();
      release();
      await first;
      expect(tasks).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(assembly.closed).toBe(true);
      await create().dispose();
    } finally {
      release();
      await assembly.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("releases the SQLite lease when artifact initialization fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-assembly-failed-"));
    const artifactPath = join(dataDir, "artifacts");
    const options = {
      config: parseConfigObject({ runtime: { dataDir } }),
      channels: new InMemoryChannelRegistry(),
      logger
    };
    try {
      writeFileSync(artifactPath, "not a directory");
      expect(() => createRuntimeAssembly(options)).toThrow();
      rmSync(artifactPath);
      await createRuntimeAssembly(options).dispose();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

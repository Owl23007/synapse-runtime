import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ConfigManager,
  ConfigResolutionError,
  defineConfig,
  deepMerge,
  EnvConfigSource,
  MemoryConfigSource,
  type ConfigType
} from "./index.js";

const settings = defineConfig({
  id: "editor",
  defaults: { interval: 10, nested: { enabled: true, size: 5 }, items: [1, 2] },
  parse(value) {
    const result = value as { interval: number; nested: { enabled: boolean; size: number }; items: number[] };
    if (typeof result.interval !== "number" || result.interval < 1) throw new Error("interval must be positive");
    return result;
  }
});

describe("modular configuration", () => {
  it("infers values from the token and resolves defaults once", async () => {
    const manager = new ConfigManager();
    manager.register(settings);
    expect(() => manager.get(settings)).toThrow(/not been resolved/);
    await manager.resolve();
    expect(manager.get(settings)).toEqual(settings.defaults);
    expect(manager.get(settings)).toBe(manager.get(settings));
    expectTypeOf(manager.get(settings)).toEqualTypeOf<ConfigType<typeof settings>>();
  });
  it("merges objects, replaces arrays, ignores undefined and preserves null", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, list: [1], n: 1 }, { a: { b: undefined }, list: [3], n: null })).toEqual({
      a: { b: 1, c: 2 },
      list: [3],
      n: null
    });
  });
  it("sorts sources and preserves them during runtime overrides and reset", async () => {
    const env = new EnvConfigSource("env", 50, "APP", { APP__editor__interval: "30" });
    const manager = new ConfigManager([
      env,
      new MemoryConfigSource("file", 20, { modules: { editor: { interval: 20, nested: { size: 9 }, items: [4] } } })
    ]);
    manager.register(settings);
    await manager.resolve();
    const listener = vi.fn<(event: { source: string; previous: unknown; next: unknown }) => void>();
    manager.onChange(settings, listener);
    manager.set(settings, { nested: { enabled: false } });
    expect(manager.get(settings)).toEqual({ interval: 30, nested: { enabled: false, size: 9 }, items: [4] });
    expect(manager.inspect(settings).sources.map((item) => item.source)).toEqual([
      "defaults",
      "file",
      "env",
      "runtime"
    ]);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ source: "runtime", previous: { nested: { enabled: true } } });
    manager.reset(settings);
    expect(manager.get(settings).nested).toEqual({ enabled: true, size: 9 });
  });
  it("does not retain rejected overrides or emit changes for them", async () => {
    const manager = new ConfigManager();
    manager.register(settings);
    await manager.resolve();
    const listener = vi.fn<(event: { source: string; previous: unknown; next: unknown }) => void>();
    manager.onChange(settings, listener);
    expect(() => manager.set(settings, { interval: -1 })).toThrow(ConfigResolutionError);
    await manager.resolve();
    expect(manager.get(settings).interval).toBe(10);
    expect(listener).not.toHaveBeenCalled();
  });
  it("publishes all definitions atomically and keeps old values after failure", async () => {
    let value = 20;
    const other = defineConfig({
      id: "other",
      defaults: 1,
      parse: (candidate: unknown) => {
        if (candidate === 40) throw new Error("invalid");
        return Number(candidate);
      }
    });
    const manager = new ConfigManager([
      {
        id: "live",
        priority: 10,
        async load() {
          return { modules: { editor: { interval: value }, other: value } };
        }
      }
    ]);
    manager.register(settings);
    manager.register(other);
    await manager.resolve();
    value = 40;
    await expect(manager.resolve()).rejects.toThrow(/other/);
    expect(manager.get(settings).interval).toBe(20);
    expect(manager.get(other)).toBe(20);
  });
  it("resolves dynamically registered modules using loaded sources and enforces identity", async () => {
    const manager = new ConfigManager([new MemoryConfigSource("app", 1, { modules: { editor: { interval: 42 } } })]);
    await manager.resolve();
    manager.register(settings);
    expect(manager.get(settings).interval).toBe(42);
    expect(() => manager.get({ ...settings })).toThrow(/Unknown config token/);
    expect(() => manager.unregister({ ...settings })).toThrow(/Unknown config token/);
    expect(() => manager.register(settings)).toThrow(/conflict/);
    manager.unregister(settings);
    expect(() => manager.get(settings)).toThrow();
  });
  it("migrates before validation and normalizes once", async () => {
    const definition = defineConfig({
      id: "versioned",
      version: 2,
      defaults: { value: 0 },
      migrate: (input: unknown) => ({ value: Number((input as { old: number }).old) }),
      normalize: (input: { value: number }) => ({ value: input.value + 1 })
    });
    const manager = new ConfigManager([
      new MemoryConfigSource("file", 1, { modules: { versioned: { $version: 1, old: 9 } } })
    ]);
    manager.register(definition);
    await manager.resolve();
    expect(manager.get(definition)).toEqual({ value: 10 });
  });
  it("protects defaults and resolved objects from accidental mutations", async () => {
    const manager = new ConfigManager();
    manager.register(settings);
    await manager.resolve();
    expect(() => {
      manager.get(settings).nested.size = 100;
    }).toThrow();
    expect(settings.defaults?.nested.size).toBe(5);
  });
  it("rejects unsafe merge and environment paths", async () => {
    expect(() => deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    await expect(
      new EnvConfigSource("env", 1, "APP", { APP__constructor__prototype__polluted: "true" }).load()
    ).rejects.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

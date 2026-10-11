import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifacts.js";
import { ContainerExecutor, type DockerCommand } from "./executor.js";
import { ContainerSettingsSchema, ContainerWorkInputSchema } from "./config.js";

const settings = ContainerSettingsSchema.parse({ enabled: true });
const file = { name: "report.csv", data: Buffer.from("name,value\n测试,1\n") };

describe("isolated container artifacts", () => {
  it("能够校验多兆工件而不会耗尽正则调用栈", async () => {
    const data = Buffer.alloc(3_000_000, 42);
    const executor = new ContainerExecutor(settings, async (command) =>
      command.args[0] === "rm"
        ? ""
        : JSON.stringify({ files: [{ name: "large.bin", base64: data.toString("base64") }], logs: "" })
    );
    expect((await executor.execute({ script: "pass", outputs: ["large.bin"] })).files[0]!.data).toEqual(data);
  });
  it("拒绝模型提供宿主参数、路径穿越和重复输出", () => {
    expect(() => ContainerWorkInputSchema.parse({ script: "pass", outputs: ["../secret"] })).toThrow();
    expect(() => ContainerWorkInputSchema.parse({ script: "pass", outputs: ["ok"], image: "host" })).toThrow();
    expect(() => ContainerWorkInputSchema.parse({ script: "pass", outputs: ["ok", "ok"] })).toThrow();
  });

  it("保存后可在新实例中恢复工件，但其他会话与篡改内容不可读取", () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-artifacts-"));
    try {
      const store = new ArtifactStore(dir, settings);
      const [artifact] = store.save({ sessionId: "group-a", runId: "run", callId: "call" }, [file]);
      const restored = new ArtifactStore(dir, settings);
      expect(restored.read("group-a", artifact!.id).data).toEqual(file.data);
      expect(() => restored.read("group-b", artifact!.id)).toThrow("当前会话");
      expect(() => restored.read("group-a", "../secret")).toThrow();
      writeFileSync(join(dir, `${artifact!.id}.bin`), Buffer.alloc(file.data.length));
      expect(() => restored.read("group-a", artifact!.id)).toThrow("完整性");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("在写入前拒绝超限工件和宿主存储配额耗尽", () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-artifact-quota-"));
    try {
      const store = new ArtifactStore(dir, { ...settings, maxArtifactBytes: 5, maxTotalBytes: 5, storageMaxBytes: 5 });
      const scope = { sessionId: "group", runId: "run", callId: "call" };
      expect(() => store.save(scope, [file])).toThrow("大小超限");
      store.save(scope, [{ name: "a.txt", data: Buffer.from("12345") }]);
      expect(() => store.save(scope, [{ name: "b.txt", data: Buffer.from("1") }])).toThrow("配额");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("使用参数数组与固定隔离策略执行，正常结果清理后返回工件", async () => {
    const commands: DockerCommand[] = [];
    const executor = new ContainerExecutor(settings, async (command) => {
      commands.push(command);
      return command.args[0] === "rm"
        ? ""
        : JSON.stringify({ files: [{ name: file.name, base64: file.data.toString("base64") }], logs: "done" });
    });
    const result = await executor.execute({ script: "print('done')", outputs: [file.name] });
    expect(result.files).toEqual([file]);
    expect(commands[0]!.args).toEqual(
      expect.arrayContaining(["--network=none", "--read-only", "--user=65534:65534", "--pull=never", "--cap-drop=ALL"])
    );
    expect(commands[0]!.args).not.toContain("--mount");
    expect(commands[0]!.args).not.toContain("print('done')");
    expect(JSON.parse(commands[0]!.stdin!).script).toBe("print('done')");
    expect(commands[1]!.args.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("执行失败和恶意返回都清理容器，不接受额外工件或非法编码", async () => {
    let removed = 0;
    const executor = new ContainerExecutor(settings, async (command) => {
      if (command.args[0] === "rm") {
        removed += 1;
        return "";
      }
      return JSON.stringify({ files: [{ name: "secret", base64: "%%%" }], logs: "" });
    });
    await expect(executor.execute({ script: "pass", outputs: [file.name] })).rejects.toThrow("无效工件");
    expect(removed).toBe(1);
    const failed = new ContainerExecutor(settings, async (command) => {
      if (command.args[0] === "rm") {
        removed += 1;
        return "";
      }
      throw new Error("execution timed out");
    });
    await expect(failed.execute({ script: "pass", outputs: [file.name] })).rejects.toThrow("timed out");
    expect(removed).toBe(2);
  });

  it("限制并发工作并在失败后释放容量", async () => {
    let release!: () => void;
    const executor = new ContainerExecutor({ ...settings, maxConcurrent: 1 }, async (command) => {
      if (command.args[0] === "rm") return "";
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("failed");
    });
    const active = executor.execute({ script: "pass", outputs: [file.name] });
    await expect(executor.execute({ script: "pass", outputs: [file.name] })).rejects.toThrow("并发");
    release();
    await expect(active).rejects.toThrow("failed");
    const next = executor.execute({ script: "pass", outputs: [file.name] });
    release();
    await expect(next).rejects.toThrow("failed");
  });
});

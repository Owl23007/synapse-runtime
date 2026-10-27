import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { runMaintenanceCommand } from "./maintenance-commands.js";

describe("离线维护命令", () => {
  it("可完成备份、验证和新目录恢复，不需要部署凭据", async () => {
    const root = mkdtempSync(join(tmpdir(), "synapse-maintenance-cli-"));
    const data = join(root, "data"),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    const store = new SqliteRuntimeContextStore({ databasePath: join(data, "runtime-context.sqlite") });
    store.close();
    try {
      expect(await runMaintenanceCommand(["backup", "--data-dir", data, "--output", backup])).toMatchObject({
        ok: true,
        command: "backup",
        files: 1
      });
      expect(await runMaintenanceCommand(["verify", "--backup", backup])).toMatchObject({
        ok: true,
        command: "verify"
      });
      expect(await runMaintenanceCommand(["restore", "--backup", backup, "--data-dir", restored])).toMatchObject({
        ok: true,
        command: "restore"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("拒绝遗漏、拼错或混用的参数，不把它们变成维护默认值", async () => {
    await expect(runMaintenanceCommand(["backup"])).rejects.toThrow("缺少");
    await expect(runMaintenanceCommand(["restore", "--apply"])).rejects.toThrow();
    await expect(runMaintenanceCommand(["verify", "--backup", "missing", "--output", "oops"])).rejects.toThrow(
      "不接受"
    );
    await expect(runMaintenanceCommand(["backup", "restore"])).rejects.toThrow("指定");
  });
});

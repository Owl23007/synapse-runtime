import { parseArgs } from "node:util";
import { backupRuntimeData, restoreRuntimeData, verifyRuntimeBackup } from "@synapse/runtime-core/maintenance";

/** 执行显式离线维护命令，不加载凭据、不启动频道或模型 */
export async function runMaintenanceCommand(args: readonly string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      output: { type: "string" },
      backup: { type: "string" },
      help: { type: "boolean" }
    }
  });
  if (values.help)
    return {
      usage: [
        "synapse-maintenance backup --data-dir <已停止的运行目录> --output <全新备份目录>",
        "synapse-maintenance verify --backup <备份目录>",
        "synapse-maintenance restore --backup <备份目录> --data-dir <全新运行目录>"
      ]
    };
  const command = positionals[0];
  if (positionals.length !== 1 || !["backup", "verify", "restore"].includes(command ?? ""))
    throw new Error("请指定 backup、verify 或 restore，使用 --help 查看参数");
  const allowed =
    command === "backup" ? ["data-dir", "output"] : command === "restore" ? ["backup", "data-dir"] : ["backup"];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`该命令不接受 --${key}`);
  const required = (key: "data-dir" | "output" | "backup"): string => {
    const value = values[key];
    if (!value?.trim()) throw new Error(`缺少 --${key}`);
    return value;
  };
  const manifest =
    command === "backup"
      ? await backupRuntimeData({ dataDir: required("data-dir"), destination: required("output") })
      : command === "restore"
        ? await restoreRuntimeData({ backupDir: required("backup"), dataDir: required("data-dir") })
        : await verifyRuntimeBackup(required("backup"));
  return {
    ok: true,
    command,
    createdAt: manifest.createdAt,
    databaseVersion: manifest.databaseVersion,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  };
}

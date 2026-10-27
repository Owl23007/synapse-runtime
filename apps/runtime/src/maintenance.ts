#!/usr/bin/env node
import { runMaintenanceCommand } from "./maintenance-commands.js";

try {
  console.log(JSON.stringify(await runMaintenanceCommand(process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "数据维护失败" }));
  process.exitCode = 1;
}

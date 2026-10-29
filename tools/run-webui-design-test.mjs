import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 示例已从应用移除，材质回归仅在测试进程启用独立夹具
const result = spawnSync(
  process.execPath,
  ["--test", fileURLToPath(new URL("./webui-design.test.mjs", import.meta.url))],
  {
    stdio: "inherit",
    env: { ...process.env, SYNAPSE_WEBUI_TEST_FIXTURES: "1" },
    windowsHide: true
  }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

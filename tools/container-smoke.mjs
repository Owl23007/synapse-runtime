import assert from "node:assert/strict";
import { ContainerExecutor } from "../packages/tool-container/dist/index.js";
import { ContainerSettingsSchema } from "../packages/tool-container/dist/config.js";

// 单独的真实 Docker 验收入口，默认测试无需依赖开发者已安装容器引擎
const executor = new ContainerExecutor(ContainerSettingsSchema.parse({ enabled: true, timeoutMs: 2000 }));
const result = await executor.execute({
  script: "from pathlib import Path\nPath('report.csv').write_text('name,value\\n测试,42\\n', encoding='utf-8')",
  outputs: ["report.csv"]
});
assert.equal(Buffer.from(result.files[0].data).toString("utf8"), "name,value\n测试,42\n");
await assert.rejects(executor.execute({ script: "import time; time.sleep(20)", outputs: ["missing.txt"] }));
await assert.rejects(
  executor.execute({ script: "import os; os.symlink('/etc/passwd','secret.txt')", outputs: ["secret.txt"] })
);
console.log("真实容器验收通过：生成工件、超时终止、拒绝符号链接");

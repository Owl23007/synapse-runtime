import { createRequire } from "node:module";

// 原生 SQLite 模块与 Node ABI 绑定，提前打开内存库可避免构建完成后才发现运行环境不可用
const require = createRequire(new URL("../packages/runtime-core/package.json", import.meta.url));
try {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error(`需要 Node.js 24，当前为 ${process.versions.node}`);
  }
  const Database = require("better-sqlite3");
  const database = new Database(":memory:");
  try {
    database.prepare("SELECT 1").get();
  } finally {
    database.close();
  }
  console.log(`环境检查通过：Node.js ${process.versions.node}，SQLite 原生模块可用`);
} catch (error) {
  console.error(`环境检查失败：${error instanceof Error ? error.message : String(error)}`);
  console.error("切换到 Node.js 24 后执行 pnpm native:rebuild，再运行 pnpm verify");
  process.exitCode = 1;
}

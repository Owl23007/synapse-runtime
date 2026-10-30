import { readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const removed = [];

function clean(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      clean(path);
      continue;
    }
    if (dir.split(/[\\/]/).includes("dist") && /\.(?:test|spec)\.[cm]?js$/.test(entry.name)) {
      unlinkSync(path);
      removed.push(path);
    }
  }
}

for (const group of ["apps", "packages"]) {
  for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
    if (entry.isDirectory()) clean(resolve(root, group, entry.name));
  }
}

console.log(`清理 ${removed.length} 个构建产物中的测试文件`);

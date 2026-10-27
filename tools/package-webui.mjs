import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "apps/webui/dist");
const target = resolve(root, "apps/runtime/dist/webui");
// 仅在完整工作区构建成功后打包，服务端无需依赖 React 或跨应用导入
await readFile(resolve(source, "index.html"));
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log("WebUI 已打包到 Runtime Admin 静态资源目录");

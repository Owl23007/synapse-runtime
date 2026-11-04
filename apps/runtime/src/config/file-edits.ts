import { resolve } from "node:path";

const writes = new Map<string, Promise<unknown>>();

/** 所有管理配置写入共享文件队列，避免频道与设置页的读改写互相覆盖 */
export async function enqueueConfigFileEdit<T>(path: string, edit: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const write = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(edit);
  writes.set(key, write);
  try {
    return await write;
  } finally {
    if (writes.get(key) === write) writes.delete(key);
  }
}

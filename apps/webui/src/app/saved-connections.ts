import { normalizeEndpoint, record } from "../shared/lib/runtime.js";

/** 仅存储连接元数据，版本号用于隔离未来不兼容的数据结构 */
export const CONNECTIONS_STORAGE_KEY = "synapse.runtime.connections.v1";

/** 浏览器连接书签，禁止扩展为令牌或其他认证材料的容器 */
export interface SavedConnection {
  readonly endpoint: string;
  readonly name: string;
  readonly lastConnectedAt: number | null;
}

const MAX_CONNECTIONS = 20;

/** 识别本机地址，用于默认名称和明文 HTTP 的本地开发边界 */
export function isLocalEndpoint(endpoint: string): boolean {
  const { hostname } = new URL(endpoint);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/** 创建连接书签，不接受调用方附带的认证字段 */
export function createSavedConnection(
  endpoint: string,
  name?: string,
  lastConnectedAt: number | null = null
): SavedConnection {
  const normalized = normalizeEndpoint(endpoint);
  return {
    endpoint: normalized,
    name: name?.trim().slice(0, 80) || (isLocalEndpoint(normalized) ? "Local Runtime" : "Remote Runtime"),
    lastConnectedAt:
      lastConnectedAt !== null && Number.isSafeInteger(lastConnectedAt) && lastConnectedAt >= 0 ? lastConnectedAt : null
  };
}

function sanitizeConnections(values: readonly unknown[]): SavedConnection[] {
  const connections = new Map<string, SavedConnection>();
  for (const value of values) {
    const item = record(value);
    if (typeof item.endpoint !== "string" || item.endpoint.length > 2048 || typeof item.name !== "string") continue;
    try {
      const connection = createSavedConnection(
        item.endpoint,
        item.name,
        typeof item.lastConnectedAt === "number" ? item.lastConnectedAt : null
      );
      const previous = connections.get(connection.endpoint);
      if (!previous || (connection.lastConnectedAt ?? -1) > (previous.lastConnectedAt ?? -1))
        connections.set(connection.endpoint, connection);
    } catch {
      // 本地存储可被扩展或旧版本修改，非法地址不能恢复为可访问的连接
    }
  }
  return [...connections.values()]
    .toSorted((a, b) => (b.lastConnectedAt ?? -1) - (a.lastConnectedAt ?? -1))
    .slice(0, MAX_CONNECTIONS);
}

/** 读取不可信的本地元数据，单条损坏不影响其他书签；存储访问错误交由界面提示 */
export function readSavedConnections(storage: Pick<Storage, "getItem">): SavedConnection[] {
  const raw = storage.getItem(CONNECTIONS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? sanitizeConnections(parsed) : [];
  } catch {
    return [];
  }
}

/** 按字段白名单写入元数据，避免运行时对象夹带令牌；空列表直接移除存储项 */
export function writeSavedConnections(
  storage: Pick<Storage, "setItem" | "removeItem">,
  connections: readonly SavedConnection[]
): void {
  const safe = sanitizeConnections(connections);
  if (safe.length) storage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(safe));
  else storage.removeItem(CONNECTIONS_STORAGE_KEY);
}

/** 按标准化地址去重并保留最近连接顺序，最多保留二十条 */
export function upsertSavedConnection(
  connections: readonly SavedConnection[],
  connection: SavedConnection
): SavedConnection[] {
  return sanitizeConnections([connection, ...connections.filter((item) => item.endpoint !== connection.endpoint)]);
}

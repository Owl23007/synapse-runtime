import { describe, expect, it, vi } from "vitest";
import {
  CONNECTIONS_STORAGE_KEY,
  createSavedConnection,
  isLocalEndpoint,
  readSavedConnections,
  upsertSavedConnection,
  writeSavedConnections
} from "../../../src/app/saved-connections.js";

function deniedStorageAccess(): never {
  throw new Error("storage denied");
}

describe("连接书签的存储边界", () => {
  it("只写入元数据白名单，额外认证字段不会被序列化", () => {
    const setItem = vi.fn<Storage["setItem"]>();
    const connection = {
      ...createSavedConnection("https://runtime.example.com", "开发服务", 123),
      token: "secret-token",
      password: "secret-password",
      authorization: "Bearer secret",
      nested: { credential: "secret" }
    };
    writeSavedConnections({ setItem, removeItem: vi.fn<Storage["removeItem"]>() }, [connection]);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(
      CONNECTIONS_STORAGE_KEY,
      JSON.stringify([{ endpoint: "https://runtime.example.com", name: "开发服务", lastConnectedAt: 123 }])
    );
  });
  it("拒绝历史数据中的脚本协议、路径和 URL 凭据，并剥离额外字段", () => {
    const valid = { endpoint: "HTTPS://RUNTIME.EXAMPLE.COM:443/", name: "服务", lastConnectedAt: 5, token: "secret" };
    const bad = [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://token@host",
      "https://host?token=secret",
      "https://host/#secret",
      "https://host/admin",
      "invalid"
    ];
    const getItem = vi.fn<Storage["getItem"]>(() =>
      JSON.stringify([null, [], {}, ...bad.map((endpoint) => ({ endpoint, name: "服务" })), valid])
    );
    expect(readSavedConnections({ getItem })).toEqual([
      { endpoint: "https://runtime.example.com", name: "服务", lastConnectedAt: 5 }
    ]);
    expect(getItem).toHaveBeenCalledWith(CONNECTIONS_STORAGE_KEY);
  });
  it("损坏或未知格式的数据不会阻止登录", () => {
    for (const raw of [null, "", "{bad", "null", "{}", "42", '"text"'])
      expect(readSavedConnections({ getItem: () => raw })).toEqual([]);
    const connections = readSavedConnections({
      getItem: () => JSON.stringify([{ endpoint: "http://localhost", name: " ", lastConnectedAt: -1 }])
    });
    expect(connections).toEqual([{ endpoint: "http://localhost", name: "Local Runtime", lastConnectedAt: null }]);
  });
  it("按规范化地址去重并按成功连接时间排序，手动添加的书签排在后面", () => {
    const items = [
      createSavedConnection("https://b.example", "B", 20),
      createSavedConnection("https://a.example", "A", 10),
      createSavedConnection("https://c.example", "C")
    ];
    const next = upsertSavedConnection(items, createSavedConnection("https://a.example:443/", "A 的新名称", 30));
    expect(next.map((item) => item.name)).toEqual(["A 的新名称", "B", "C"]);
    const raw = JSON.stringify([...next, createSavedConnection("https://a.example", "旧名称", 1)]);
    expect(readSavedConnections({ getItem: () => raw })).toEqual(next);
  });
  it("限制记录数量与名称长度，连接时间异常时回退为未连接", () => {
    const values = Array.from({ length: 30 }, (_, i) =>
      createSavedConnection(`https://r${i}.example`, "x".repeat(100), i)
    );
    const restored = readSavedConnections({ getItem: () => JSON.stringify(values) });
    expect(restored).toHaveLength(20);
    expect(restored[0]?.endpoint).toBe("https://r29.example");
    expect(restored[0]?.name).toHaveLength(80);
    for (const time of [NaN, Infinity, -1, 1.2])
      expect(createSavedConnection("http://localhost", undefined, time).lastConnectedAt).toBeNull();
  });
  it("仅将真实回环主机视为本地，拒绝相似域名绕过 HTTPS 边界", () => {
    for (const endpoint of [
      "http://localhost",
      "http://dev.localhost",
      "http://127.0.0.1",
      "http://127.1",
      "http://[::1]"
    ])
      expect(isLocalEndpoint(endpoint)).toBe(true);
    for (const endpoint of ["http://127.evil.example", "http://localhost.example", "http://192.168.1.100"])
      expect(isLocalEndpoint(endpoint)).toBe(false);
  });
  it("删除全部记录时移除存储项，不保留空数据", () => {
    const removeItem = vi.fn<Storage["removeItem"]>();
    const setItem = vi.fn<Storage["setItem"]>();
    writeSavedConnections({ setItem, removeItem }, []);
    expect(removeItem).toHaveBeenCalledExactlyOnceWith(CONNECTIONS_STORAGE_KEY);
    expect(setItem).not.toHaveBeenCalled();
  });
  it("存储禁用和配额错误可由界面捕获，并与认证失败分开处理", () => {
    expect(() => readSavedConnections({ getItem: deniedStorageAccess })).toThrow("storage denied");
    expect(() =>
      writeSavedConnections({ setItem: deniedStorageAccess, removeItem: deniedStorageAccess }, [
        createSavedConnection("http://localhost")
      ])
    ).toThrow("storage denied");
  });
});

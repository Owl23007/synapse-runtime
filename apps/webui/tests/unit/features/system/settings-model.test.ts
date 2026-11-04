import { describe, expect, it } from "vitest";
import {
  changeConfigDraft,
  configVariant,
  initialConfigValue
} from "../../../../src/features/system/settings-model.js";

describe("设置表单草稿", () => {
  it("选用对应提供商的字段并为新增项创建必填值", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            type: { const: "api" },
            model: { type: "string" },
            temperature: { type: "number", default: 0.3 }
          },
          required: ["type", "model"]
        },
        {
          type: "object",
          properties: { type: { const: "echo" }, prefix: { type: "string", default: "" } },
          required: ["type"]
        }
      ]
    };
    expect(configVariant(schema, { type: "echo" }).properties).toHaveProperty("prefix");
    expect(initialConfigValue(schema)).toEqual({ type: "api", model: "" });
    expect(initialConfigValue({ type: "integer", minimum: 1 })).toBe(1);
  });

  it("权限名中的点号保持为单个键，且不会改写读取快照", () => {
    const snapshot = { permissions: { "network.web.fetch": "allow" } };
    expect(changeConfigDraft(snapshot, { path: ["permissions", "network.web.fetch"], value: "deny" })).toEqual({
      permissions: { "network.web.fetch": "deny" }
    });
    expect(snapshot.permissions["network.web.fetch"]).toBe("allow");
  });

  it("顺序删除和编辑数组项，保留剩余项的隐藏凭据", () => {
    const before = {
      connections: [
        { id: "a", token: "[REDACTED]" },
        { id: "b", token: "[REDACTED]" }
      ]
    };
    const removed = changeConfigDraft(before, { path: ["connections", "0"], remove: true });
    expect(changeConfigDraft(removed, { path: ["connections", "0", "id"], value: "updated" })).toEqual({
      connections: [{ id: "updated", token: "[REDACTED]" }]
    });
  });
});

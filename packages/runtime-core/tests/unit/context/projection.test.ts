import { describe, expect, it } from "vitest";
import { allocateContext } from "../../../src/context/budget.js";
import type { PromptContext } from "@synapse/runtime-conversation";

describe("统一上下文预算与来源清单", () => {
  it("按来源和版本去重，保留相同文本的不同事实", () => {
    const context: PromptContext = {
      metadata: {},
      sections: [],
      messages: [
        { role: "user", content: "同一句话", sourceRef: "event:a", createdAt: "1" },
        { role: "user", content: "同一句话", sourceRef: "event:b", createdAt: "1" },
        { role: "user", content: "同一句话", sourceRef: "event:a", createdAt: "1" },
        { role: "user", content: "修订", sourceRef: "event:a", createdAt: "2" }
      ]
    };
    const selected = allocateContext(context, 1000, 50);
    expect(selected.context.messages).toEqual(context.messages.slice(1));
    expect(selected.manifest.entries.filter((entry) => entry.reason === "duplicate")).toHaveLength(1);
    const actual =
      50 +
      selected.context.messages.reduce(
        (sum, message) => sum + JSON.stringify({ role: message.role, content: message.content }).length,
        0
      );
    expect(selected.manifest.usedChars).toBe(actual);
  });
  it("完整舍弃超额区块和消息，必需内容无法容纳时明确失败", () => {
    const context: PromptContext = {
      metadata: {},
      sections: [
        {
          id: "context",
          blocks: [
            { id: "seed", source: "runtime", content: "可信种子", required: true, priority: 100, stability: "turn" },
            {
              id: "large",
              source: "memory",
              content: JSON.stringify({ nested: "x".repeat(500) }),
              required: false,
              priority: 1,
              stability: "turn"
            }
          ]
        }
      ],
      messages: [{ role: "assistant", content: "y".repeat(300) }]
    };
    const selected = allocateContext(context, 150, 20);
    expect(selected.context.sections[0]?.blocks.map((block) => block.id)).toEqual(["seed"]);
    expect(selected.context.messages).toEqual([]);
    expect(selected.manifest.entries.filter((entry) => entry.reason === "budget")).toHaveLength(2);
    expect(selected.manifest.usedChars).toBeLessThanOrEqual(150);
    expect(() => allocateContext(context, 25, 20)).toThrow(/Required context/);
  });
});

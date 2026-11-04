import { describe, expect, it } from "vitest";
import { PromptBundleCompiler } from "../../src/bundle.js";

describe("能力策略使用编译后的工具集合", () => {
  it("Skill 收窄工具后移除相关策略，缓存不会混用能力", () => {
    const compiler = new PromptBundleCompiler(
      {
        prompts: [
          { id: "core", stage: "reasoning", slot: "runtime", template: "核心规则" },
          {
            id: "task-policy",
            stage: "reasoning",
            slot: "capability",
            template: "任务规则",
            whenTools: ["task.create"]
          }
        ],
        recipes: [{ id: "chat", purpose: "reasoning.chat", basePromptIds: ["core", "task-policy"] }],
        skills: [{ id: "readonly", description: "只读", purposes: ["reasoning.chat"], allowedTools: [] }]
      },
      {}
    );
    const input = { purpose: "reasoning.chat", dimensions: {}, toolIds: ["task.create"], toolSetDigest: "task" };
    expect(compiler.compile(input).prompt.blocks.map((block) => block.promptId)).toEqual(["core", "task-policy"]);
    const restricted = compiler.compile({ ...input, requestedSkillIds: ["readonly"] });
    expect(restricted.capabilities.toolIds).toEqual([]);
    expect(restricted.prompt.blocks.map((block) => block.promptId)).toEqual(["core"]);
    expect(compiler.compile(input).prompt.blocks.map((block) => block.promptId)).toEqual(["core", "task-policy"]);
  });
});

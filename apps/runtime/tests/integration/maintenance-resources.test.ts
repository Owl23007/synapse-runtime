import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { CapabilityService } from "@synapse/runtime-core/capabilities";
import { parseConfigObject } from "../../src/config/index.js";
import { runMaintenanceCommand } from "../../src/maintenance-commands.js";
import { createAdminServerFixture } from "../helpers/admin-server.js";

describe("Runtime 资源备份恢复闭环", () => {
  it("HTTP 上传附件、安装 Skill、停机备份、迁移路径并重启后实际读取", async () => {
    const root = mkdtempSync(join(tmpdir(), "synapse-resource-restore-http-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const data = join(root, "original-data");
    const skills = join(root, "original-skills");
    const external = join(root, "external-skill");
    mkdirSync(join(external, "references"), { recursive: true });
    writeFileSync(join(external, "SKILL.md"), "---\nname: reports\ndescription: 报告分析\n---\n读取附件并分析");
    writeFileSync(join(external, "references", "guide.md"), "离线报告指南");
    const context = new SqliteRuntimeContextStore({ databasePath: join(data, "runtime-context.sqlite") });
    onTestFinished(() => context.close());
    await context.resolveWorkspace({
      platform: "qq",
      provider: "napcat",
      channelId: "qq",
      conversationType: "group",
      conversationId: "a",
      identityId: "actor",
      defaultWorkspace: { id: "a", type: "group", name: "a" }
    });
    const capability = new CapabilityService(
      context.capabilities,
      skills,
      [],
      async () => {
        throw new Error("offline");
      },
      []
    );
    const install = capability.registerDirectory(external, "runtime:reports", "admin");
    capability.bind("a", install.packageKey, { installId: install.id, enabled: true }, "admin");
    context.close();
    const config = (dataDir: string, skillsDirectory: string) =>
      parseConfigObject({
        runtime: { dataDir },
        server: { host: "127.0.0.1", port: 0 },
        admin: { host: "127.0.0.1", port: 0, token: "test-resource-token" },
        capabilities: { autoCheckUpdates: false, skillsDirectory }
      });
    const original = await createAdminServerFixture(config(data, skills));
    const sessionResponse = await fetch(original.endpoint + "/admin/sessions", {
      method: "POST",
      headers: { authorization: "Bearer test-resource-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "恢复验证", idempotencyKey: "session", workspaceId: "a" })
    });
    expect(sessionResponse.status).toBe(200);
    const { session } = (await sessionResponse.json()) as { session: { id: string; mainlineId: string } };
    const uploaded = await original.client.uploadAsset(
      "a",
      new File(["真实附件内容"], "附件.txt", { type: "text/plain" }),
      "upload"
    );
    const run = await original.client.submitRun({
      sessionId: session.id,
      lineId: session.mainlineId,
      text: "查看附件",
      idempotencyKey: "run",
      attachments: [{ assetId: uploaded.asset.id, versionId: uploaded.version.id }]
    });
    await expect.poll(async () => (await original.client.run(run.run.id)).run.status).toBe("succeeded");
    const history = await original.client.run(run.run.id);
    const dependencies = await original.client.runDependencies(run.run.id);
    await original.server.stop();
    const backup = join(root, "backup");
    await expect(
      runMaintenanceCommand(["backup", "--data-dir", data, "--skills-dir", skills, "--output", backup])
    ).resolves.toMatchObject({ ok: true });
    await expect(runMaintenanceCommand(["verify", "--backup", backup])).resolves.toMatchObject({ ok: true });
    const restoredData = join(root, "restored-data");
    const restoredSkills = join(root, "restored-skills");
    await expect(
      runMaintenanceCommand(["restore", "--backup", backup, "--data-dir", restoredData, "--skills-dir", restoredSkills])
    ).resolves.toMatchObject({ ok: true });
    // 删除源部署后重启，保证 HTTP 读取实际来自恢复后的两个存储根
    rmSync(data, { recursive: true });
    rmSync(skills, { recursive: true });
    rmSync(external, { recursive: true });
    const restored = await createAdminServerFixture(config(restoredData, restoredSkills));
    expect(await (await restored.client.downloadAsset(uploaded.asset.id, uploaded.version.id)).text()).toBe(
      "真实附件内容"
    );
    expect(await restored.client.capabilityResource(install.id, "references/guide.md")).toMatchObject({
      resource: { text: "离线报告指南" }
    });
    expect(await restored.client.workspaceCapabilities("a")).toMatchObject({
      items: [expect.objectContaining({ installId: install.id, enabled: true })]
    });
    expect(await restored.client.run(run.run.id)).toEqual(history);
    expect(await restored.client.runDependencies(run.run.id)).toEqual(dependencies);
  });
});

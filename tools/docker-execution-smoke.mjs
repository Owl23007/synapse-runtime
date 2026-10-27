import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDockerTool } from "../packages/tool-execution/dist/index.js";
import { DockerToolSettingsSchema } from "../packages/tool-execution/dist/config.js";

const settings = DockerToolSettingsSchema.parse({ enabled: true });
const context = { runId: "smoke", sessionId: "smoke", userId: "smoke" };
const tool = createDockerTool(settings);
const generated = await tool.handle(
  {
    command: `python - <<'PY'
from pptx import Presentation
from PIL import Image
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0])
s.shapes.title.text = "Runtime execution smoke test"
p.save("demo.pptx")
assert len(Presentation("demo.pptx").slides) == 1
Image.new("RGB", (32, 32), "red").save("demo.png")
assert Image.open("demo.png").size == (32, 32)
print("PPT and image verified")
PY`,
    artifacts: [
      { path: "demo.pptx", type: "file" },
      { path: "demo.png", type: "image" }
    ]
  },
  context
);
assert.equal(generated.modelOutput.exitCode, 0);
assert.equal(generated.attachments.length, 2);
assert.equal(Buffer.from(generated.attachments[0].url.slice(9), "base64").subarray(0, 2).toString(), "PK");
assert.equal(
  Buffer.from(generated.attachments[1].url.slice(9), "base64").subarray(0, 8).toString("hex"),
  "89504e470d0a1a0a"
);
await assert.rejects(tool.handle({ command: "true", artifacts: [{ path: "missing.txt" }] }, context), /regular file/);
await assert.rejects(
  tool.handle({ command: "ln -s /etc/passwd outside.txt", artifacts: [{ path: "outside.txt" }] }, context),
  /inside \/workspace/
);
await assert.rejects(
  createDockerTool({ ...settings, maxArtifactBytes: 1024 }).handle(
    { command: "python -c \"open('big.bin','wb').write(b'x'*2048)\"", artifacts: [{ path: "big.bin" }] },
    context
  ),
  /size limit/
);
const failed = await tool.handle(
  { command: "echo command-failed >&2; exit 3", artifacts: [{ path: "missing.txt" }] },
  context
);
assert.equal(failed.modelOutput.exitCode, 3);
assert.equal(failed.attachments.length, 0);
await assert.rejects(
  createDockerTool({ ...settings, timeoutMs: 1000 }).handle({ command: "sleep 30" }, context),
  /timed out/
);
const containers = execFileSync(
  "docker",
  ["ps", "-a", "--filter", "name=synapse-execution-", "--format", "{{.Names}}"],
  { encoding: "utf8", windowsHide: true }
);
assert.equal(containers.trim(), "", "Smoke test must leave no execution containers");
console.log(
  "Docker smoke passed: real PPT/image, missing artifact, symlink escape, size limit, nonzero exit, timeout and cleanup"
);

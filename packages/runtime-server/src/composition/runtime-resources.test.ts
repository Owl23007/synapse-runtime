import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigObject } from "@synapse/runtime-config";
import { describe, expect, it } from "vitest";
import { createPresentationProfileFromConfig } from "./runtime-resources.js";

describe("runtime presentation resources", () => {
  it("loads the selected deterministic profile during composition", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-presentation-"));
    const profilePath = join(directory, "profiles.yaml");
    writeFileSync(profilePath, "profiles:\n  - id: concise\n    maxChars: 600\n");
    const config = parseConfigObject({
      presentation: { mode: "deterministic", profilePath, defaultProfileId: "concise" }
    });

    expect(createPresentationProfileFromConfig(config)).toMatchObject({
      id: "concise",
      enabled: true,
      locale: "zh-CN",
      maxChars: 600
    });
  });

  it("fails startup composition when the selected profile is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-presentation-missing-"));
    const profilePath = join(directory, "profiles.yaml");
    writeFileSync(profilePath, "profiles:\n  - id: default\n");
    const config = parseConfigObject({
      presentation: { mode: "deterministic", profilePath, defaultProfileId: "missing" }
    });

    expect(() => createPresentationProfileFromConfig(config)).toThrow("presentation.profile_not_found");
  });
});

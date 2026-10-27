import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChannelOperationResult } from "@synapse/runtime-protocol";
import {
  artifactDeliveryIdentity,
  deliverArtifact,
  type ArtifactDeliveryKey,
  type ArtifactDeliveryRecord,
  type ArtifactDeliveryReceipts
} from "./artifact-delivery.js";

const key = { sessionId: "session", channelId: "qq", groupId: "42", artifactId: "report" };

function receipts() {
  const records = new Map<string, ArtifactDeliveryRecord>();
  const port: ArtifactDeliveryReceipts = {
    get: (key) => records.get(artifactDeliveryIdentity(key)),
    claim: (key) => {
      const id = artifactDeliveryIdentity(key);
      if (records.has(id)) return false;
      records.set(id, { status: "pending" });
      return true;
    },
    complete: (key, result) => {
      records.set(artifactDeliveryIdentity(key), result);
    }
  };
  return port;
}

describe("工件交付用例", () => {
  it("preserves historical receipt identity and isolates sessions, channels and groups", () => {
    expect(artifactDeliveryIdentity(key)).toBe(createHash("sha256").update(JSON.stringify(key)).digest("hex"));
    expect(
      artifactDeliveryIdentity({
        artifactId: key.artifactId,
        groupId: key.groupId,
        channelId: key.channelId,
        sessionId: key.sessionId
      })
    ).toBe(artifactDeliveryIdentity(key));
    for (const field of ["sessionId", "channelId", "groupId", "artifactId"] as const)
      expect(artifactDeliveryIdentity({ ...key, [field]: "other" })).not.toBe(artifactDeliveryIdentity(key));
  });

  it.each(["succeeded", "failed", "unsupported", "uncertain"] as const)(
    "reuses %s without another external effect",
    async (status) => {
      const port = receipts();
      const result: ChannelOperationResult =
        status === "succeeded" ? { status, fileId: "platform-id" } : { status, error: "platform result" };
      const upload = vi.fn<() => Promise<ChannelOperationResult>>().mockResolvedValue(result);
      expect(await deliverArtifact(port, key, upload)).toEqual(result);
      expect(await deliverArtifact(port, key, upload)).toEqual(result);
      expect(upload).toHaveBeenCalledOnce();
    }
  );

  it("retains uncertainty when receipt persistence fails after upload and snapshots caller identity", async () => {
    const port = receipts();
    const complete = port.complete;
    const failWrite: ArtifactDeliveryReceipts = {
      ...port,
      complete: () => {
        throw new Error("disk unavailable");
      }
    };
    const mutable: ArtifactDeliveryKey & { groupId: string } = { ...key };
    const upload = vi.fn<() => Promise<ChannelOperationResult>>().mockImplementation(async () => {
      mutable.groupId = "changed-during-upload";
      return { status: "succeeded" };
    });
    await expect(deliverArtifact(failWrite, mutable, upload)).rejects.toThrow("disk unavailable");
    expect(await deliverArtifact({ ...port, complete }, key, upload)).toMatchObject({ status: "uncertain" });
    expect(upload).toHaveBeenCalledOnce();
    expect(port.get({ ...key, groupId: "changed-during-upload" })).toBeUndefined();
  });
});

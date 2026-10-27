import { describe, expect, it, vi } from "vitest";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import { RuntimeInspection, InspectionQueryError, type ArtifactReader } from "./runtime-inspection.js";

describe("RuntimeInspection", () => {
  it("bounds queries and keeps commits and artifact lists within the requested session", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:", traceSecrets: ["deployment-secret"] });
    const artifacts: ArtifactReader = {
      list: vi.fn<ArtifactReader["list"]>(() => ({ items: [] })),
      describe: () => {
        throw new Error("not owned");
      },
      read: () => {
        throw new Error("not owned");
      }
    };
    const inspection = new RuntimeInspection(store, artifacts);
    try {
      await store.ensureSession({ sessionId: "a" });
      await store.ensureSession({ sessionId: "b" });
      const commit = store.contextGraph.commit({
        scopeId: "a",
        refName: "main",
        expectedVersion: null,
        idempotencyKey: "first",
        type: "input",
        content: { text: "deployment-secret" }
      });
      expect(inspection.getCommit("b", commit.id)).toBeUndefined();
      expect(JSON.stringify(inspection.getCommit("a", commit.id))).not.toContain("deployment-secret");
      expect(await inspection.getTranscript("missing")).toBeUndefined();
      expect(await inspection.listArtifacts("missing")).toBeUndefined();
      expect(artifacts.list).not.toHaveBeenCalled();
      expect(inspection.getArtifact("b", "a-file")).toBeUndefined();
      expect(inspection.readArtifact("b", "a-file")).toBeUndefined();
      const first = inspection.listSessions(1);
      expect(first.items).toHaveLength(1);
      expect(inspection.listSessions(1, first.nextCursor!).items).toHaveLength(1);
      expect(() => inspection.listRuns({ limit: 201 })).toThrow(InspectionQueryError);
      expect(() => inspection.listRuns({ since: "2026-10-28", until: "2026-10-27" })).toThrow(InspectionQueryError);
      expect(() => inspection.streamEvents(-1)).toThrow(InspectionQueryError);
    } finally {
      store.close();
    }
  });

  it("captures a durable stream boundary and reads later events", () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    const inspection = new RuntimeInspection(store, {
      list: () => ({ items: [] }),
      describe: () => undefined,
      read: () => {
        throw new Error();
      }
    });
    try {
      const run = store.runs.accept({ sourceEventId: "one", sessionId: "a", channelId: "qq", summary: "one" });
      const snapshot = inspection.streamSnapshot();
      store.runs.append(run.id, { key: "start", type: "run_started", status: "running" });
      expect(snapshot.cursor).toBe(snapshot.highWaterMark);
      expect(inspection.streamEvents(snapshot.cursor).map((event) => event.type)).toEqual(["run_started"]);
      expect(inspection.getRunEvents(run.id, 0, 1)).toMatchObject({ nextSeq: 1, hasMore: true });
      expect(inspection.getRunContext("missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

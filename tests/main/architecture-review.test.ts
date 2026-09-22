import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  compareArchitectureMaps,
  createArchitectureInputFingerprint,
  adoptArchitectureReview,
  isArchitectureReviewActive,
  markArchitectureReviewFailedIfCurrent,
  readArchitectureReviewStatus,
  startArchitectureReview,
  writeArchitectureReviewStatus
} from "../../src/main/services/architecture-review.service";
import type { ArchitectureMap, ArtifactGenerationMetadata, ArchitectureReviewStatus } from "../../src/types";

const architectureStatusWriteFault = vi.hoisted(() => ({
  path: "",
  failuresRemaining: 0
}));

vi.mock("../../src/main/storage/artifact-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/storage/artifact-store")>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, value: unknown) => {
      if (path === architectureStatusWriteFault.path && architectureStatusWriteFault.failuresRemaining > 0) {
        architectureStatusWriteFault.failuresRemaining -= 1;
        throw new Error(`Injected architecture status write failure for ${path}.`);
      }
      return actual.writeJsonAtomic(path, value);
    }
  };
});

describe("architecture-review.service", () => {
  it("summarizes added, removed, and modified modules and relationships", () => {
    const local = architectureMap(
      [
        architectureModule("api", "API", "Local API"),
        architectureModule("removed", "Removed", "Removed locally")
      ],
      [
        architectureRelationship("api-to-removed", "api", "removed", "Local relation")
      ]
    );
    const reviewed = architectureMap(
      [
        architectureModule("api", "API", "Agent-reviewed API"),
        architectureModule("added", "Added", "Added by Agent")
      ],
      [
        architectureRelationship("api-to-added", "api", "added", "Agent relation")
      ]
    );

    expect(compareArchitectureMaps(local, reviewed)).toEqual({
      modules: { added: 1, removed: 1, modified: 1 },
      relationships: { added: 1, removed: 1, modified: 0 }
    });
  });

  it("persists reviewing state and publishes the reviewed architecture after completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-"));
    const local: ArchitectureMap = {
      ...architectureMap([architectureModule("local", "Local", "Local")], []),
      metadata: { source: "local", scanFingerprint: "scan-1", inputFingerprint: "input-1" }
    };
    const reviewed: ArchitectureMap = {
      ...architectureMap([architectureModule("reviewed", "Reviewed", "Reviewed")], []),
      source: "agent",
      metadata: {
        source: "agent",
        agentId: "mock",
        runId: "run-1",
        generatedAt: "2026-06-25T00:00:00.000Z",
        scanFingerprint: "scan-1",
        inputFingerprint: "input-1",
        reviewId: "review-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];

    const initial = await startArchitectureReview({
      projectId: "project-00000000-0000-0000-0000-000000000000",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-1",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:00.000Z",
      persistLocal: async () => {
        await mkdir(join(root, ".flowweave"), { recursive: true });
        await writeFile(join(root, ".flowweave", "project.json"), JSON.stringify({ scanFingerprint: "scan-1" }), "utf8");
        await writeFile(join(root, ".flowweave", "architecture-local.json"), JSON.stringify(local), "utf8");
      },
      persist: async (architectureMap) => {
        await mkdir(join(root, ".flowweave"), { recursive: true });
        await writeFile(
          join(root, ".flowweave", "architecture-map.json"),
          `${JSON.stringify(architectureMap)}\n`,
          "utf8"
        );
      },
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async (onRunId) => {
        await onRunId("run-1");
        return { outcome: "reviewed", architectureMap: reviewed, runId: "run-1" };
      },
      onEvent: (event) => events.push(event)
    });

    expect(initial.state).toBe("reviewing");
    await waitFor(() => events.some((event) => event.status.state === "reviewed"));
    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "input-1" })).toMatchObject({
      state: "reviewed",
      reviewId: "review-1",
      runId: "run-1"
    });
    expect(events.at(-1)).toMatchObject({
      status: { state: "reviewed" },
      architectureMap: { modules: [{ id: "local" }] }
    });
  });

  it("marks persisted review state stale when the scan fingerprint changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-stale-"));
    const local = architectureMap([], []);

    await startArchitectureReview({
      projectId: "project-00000000-0000-0000-0000-000000000000",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-stale",
      scanFingerprint: "scan-old",
      inputFingerprint: "input-old",
      agentId: "mock",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:00.000Z",
      persistLocal: async () => undefined,
      persist: async () => undefined,
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async () => ({
        outcome: "failed",
        error: { code: "agent-failed", message: "failed" }
      }),
      onEvent: () => undefined
    });

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-new", inputFingerprint: "input-new" })).toMatchObject({
      state: "stale",
      reviewId: "review-stale",
      scanFingerprint: "scan-old"
    });
  });

  it("reuses the active review for the same key without creating another run", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-reuse-"));
    const local = architectureMap([], []);
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];
    const result = deferred<import("../../src/main/services/architecture-review.service").ArchitectureReviewRunResult>();
    let runCount = 0;
    let localWriteCount = 0;

    const first = await startArchitectureReview({
      projectId: "project-1",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-first",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:00.000Z",
      persistLocal: async () => { localWriteCount += 1; },
      persist: async () => undefined,
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async (onRunId) => {
        runCount += 1;
        await onRunId("run-first");
        return result.promise;
      },
      onEvent: (event) => events.push(event)
    });

    await waitFor(() => events.some((event) => event.reviewId === "review-first" && event.status.runId === "run-first"));
    const duplicate = await startArchitectureReview({
      projectId: "project-1",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-duplicate",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:01.000Z",
      persistLocal: async () => { localWriteCount += 1; },
      persist: async () => undefined,
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async () => {
        runCount += 1;
        return { outcome: "failed", error: { code: "agent-failed", message: "duplicate run" } };
      },
      onEvent: (event) => events.push(event)
    });

    expect(first).toMatchObject({ state: "reviewing", reviewId: "review-first" });
    expect(duplicate).toMatchObject({ state: "reviewing", reviewId: "review-first", runId: "run-first" });
    expect(runCount).toBe(1);
    expect(localWriteCount).toBe(1);

    result.resolve({ outcome: "failed", error: { code: "agent-failed", message: "finished" }, runId: "run-first" });
    await waitFor(() => events.some((event) => event.reviewId === "review-first" && event.status.state === "review-failed"));
  });

  it("preserves local topology through the shared adoption gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-topology-"));
    const flowweaveRoot = join(root, ".flowweave");
    await mkdir(flowweaveRoot, { recursive: true });
    await writeFile(join(flowweaveRoot, "project.json"), JSON.stringify({ scanFingerprint: "scan-1" }), "utf8");

    const local = {
      ...architectureMap([
        { ...architectureModule("core", "Core", "Local core"), files: ["src/core.ts"] },
        { ...architectureModule("data", "Data", "Local data"), files: ["src/data.ts"] }
      ], [architectureRelationship("core-data", "core", "data", "Local dependency")]),
      metadata: { source: "local" as const, scanFingerprint: "scan-1", inputFingerprint: "input-1" }
    };
    await writeFile(join(flowweaveRoot, "architecture-local.json"), JSON.stringify(local), "utf8");
    const identity = {
      projectId: "project-1",
      artifactTarget: "architecture-map" as const,
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock" as const,
      reviewId: "review-1"
    };
    await writeArchitectureReviewStatus(root, {
      ...identity,
      state: "reviewing",
      startedAt: "2026-06-25T00:00:00.000Z"
    });

    const agentMap: ArchitectureMap = {
      ...architectureMap([
        { ...architectureModule("core", "Reviewed Core", "Agent core"), files: ["src/core.ts"] },
        { ...architectureModule("extra", "Extra", "Agent invented module"), files: ["src/extra.ts"] }
      ], []),
      source: "agent",
      metadata: {
        source: "agent",
        agentId: "mock",
        runId: "run-1",
        reviewId: "review-1",
        generatedAt: "2026-06-25T00:00:01.000Z",
        scanFingerprint: "scan-1",
        inputFingerprint: "input-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    let persisted: ArchitectureMap | undefined;

    const adoption = await adoptArchitectureReview({
      ...identity,
      projectPath: root,
      runId: "run-1",
      architectureMap: agentMap,
      localArchitecture: local,
      persist: async (architectureMap) => { persisted = architectureMap; }
    });

    expect(adoption.status).toBe("applied");
    expect(persisted?.modules.map((module) => module.id)).toEqual(["core", "data"]);
    expect(persisted?.modules[0]).toMatchObject({ title: "Reviewed Core", files: ["src/core.ts"] });
    expect(persisted?.relationships).toEqual(local.relationships);
  });

  it.each(["project.json", "architecture-local.json"])(
    "rejects adoption when persisted %s evidence is missing",
    async (missingFile) => {
      const root = await mkdtemp(join(tmpdir(), "flowweave-review-missing-evidence-"));
      const flowweaveRoot = join(root, ".flowweave");
      await mkdir(flowweaveRoot, { recursive: true });
      const local = {
        ...architectureMap([], []),
        metadata: { source: "local" as const, scanFingerprint: "scan-1", inputFingerprint: "input-1" }
      };
      if (missingFile !== "project.json") {
        await writeFile(join(flowweaveRoot, "project.json"), JSON.stringify({ scanFingerprint: "scan-1" }), "utf8");
      }
      if (missingFile !== "architecture-local.json") {
        await writeFile(join(flowweaveRoot, "architecture-local.json"), JSON.stringify(local), "utf8");
      }

      const identity = {
        projectId: "project-1",
        artifactTarget: "architecture-map" as const,
        scanFingerprint: "scan-1",
        inputFingerprint: "input-1",
        agentId: "mock" as const,
        reviewId: "review-1"
      };
      await writeArchitectureReviewStatus(root, {
        ...identity,
        state: "reviewing",
        startedAt: "2026-06-25T00:00:00.000Z"
      });
      const reviewedMap: ArchitectureMap = {
        ...architectureMap([], []),
        source: "agent",
        metadata: {
          source: "agent",
          agentId: "mock",
          runId: "run-1",
          reviewId: "review-1",
          generatedAt: "2026-06-25T00:00:01.000Z",
          scanFingerprint: "scan-1",
          inputFingerprint: "input-1",
          fileCoverage: 1,
          evidenceCoverage: 1
        }
      };
      let wasPersisted = false;

      const adoption = await adoptArchitectureReview({
        ...identity,
        projectPath: root,
        runId: "run-1",
        architectureMap: reviewedMap,
        localArchitecture: local,
        persist: async () => { wasPersisted = true; }
      });

      expect(adoption.status).toBe("rejected");
      expect(wasPersisted).toBe(false);
    }
  );

  it.each([
    { name: "a newer scan", scanFingerprint: "scan-2", inputFingerprint: "input-2", agentId: "mock" as const },
    { name: "a new analysis configuration", scanFingerprint: "scan-1", inputFingerprint: "input-2", agentId: "mock" as const },
    { name: "a switched Agent", scanFingerprint: "scan-1", inputFingerprint: "input-1", agentId: "codex-local" as const }
  ])("does not adopt an older run after $name becomes active", async ({ scanFingerprint, inputFingerprint, agentId }) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-latest-"));
    const oldResult = deferred<import("../../src/main/services/architecture-review.service").ArchitectureReviewRunResult>();
    const currentResult = deferred<import("../../src/main/services/architecture-review.service").ArchitectureReviewRunResult>();
    const oldSettled = deferred<boolean>();
    const oldLocal = architectureMap([], []);
    const currentLocal = { ...architectureMap([], []), projectName: "Current local graph" };
    let activeMap: ArchitectureMap | undefined;
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];

    await startArchitectureReview({
      projectId: "project-1",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-old",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock",
      localArchitecture: oldLocal,
      startedAt: "2026-06-25T00:00:00.000Z",
      persistLocal: async () => { activeMap = oldLocal; },
      persist: async (map) => { activeMap = map; },
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async (onRunId) => {
        await onRunId("run-old");
        try {
          return await oldResult.promise;
        } finally {
          oldSettled.resolve(true);
        }
      },
      onEvent: (event) => events.push(event)
    });

    await waitFor(() => events.some((event) => event.reviewId === "review-old" && event.status.runId === "run-old"));
    await startArchitectureReview({
      projectId: "project-1",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-current",
      scanFingerprint,
      inputFingerprint,
      agentId,
      localArchitecture: currentLocal,
      startedAt: "2026-06-25T00:00:01.000Z",
      persistLocal: async () => { activeMap = currentLocal; },
      persist: async (map) => { activeMap = map; },
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async (onRunId) => {
        await onRunId("run-current");
        return currentResult.promise;
      },
      onEvent: (event) => events.push(event)
    });

    oldResult.resolve({ outcome: "reviewed", architectureMap: architectureMap([], []), runId: "run-old" });
    await oldSettled.promise;
    await waitFor(() => !isArchitectureReviewActive("review-old"));

    expect(activeMap?.projectName).toBe("Current local graph");
    expect(await readArchitectureReviewStatus(root, { scanFingerprint, inputFingerprint })).toMatchObject({
      state: "reviewing",
      reviewId: "review-current",
      agentId
    });

    currentResult.resolve({ outcome: "failed", error: { code: "agent-failed", message: "test cleanup" }, runId: "run-current" });
    await waitFor(() => events.some((event) => event.reviewId === "review-current" && event.status.state === "review-failed"));
  });

  it("changes the architecture input fingerprint when a generator contract version changes", () => {
    const common = {
      scanFingerprint: "scan-1",
      semanticIndexSchemaVersion: 4,
      semanticIndexGeneratorVersion: "4.0.0",
      moduleClusteringConfigVersion: "cluster-1",
      architectureGeneratorVersion: "architecture-1",
      reviewContractVersion: "review-1"
    };

    expect(createArchitectureInputFingerprint(common)).not.toBe(createArchitectureInputFingerprint({
      ...common,
      moduleClusteringConfigVersion: "cluster-2"
    }));
  });

  it("resumes an existing review with its original review id", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-resume-"));
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];
    await writeArchitectureReviewStatus(root, {
      state: "reviewing",
      projectId: "project-1",
      artifactTarget: "architecture-map",
      reviewId: "review-original",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock",
      runId: "run-original",
      startedAt: "2026-06-25T00:00:00.000Z"
    });
    let runCount = 0;

    const resumed = await startArchitectureReview({
      projectId: "project-1",
      artifactTarget: "architecture-map",
      projectPath: root,
      reviewId: "review-original",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "mock",
      localArchitecture: architectureMap([], []),
      startedAt: "2026-06-25T00:00:00.000Z",
      resume: true,
      persistLocal: async () => undefined,
      persist: async () => undefined,
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async (onRunId) => {
        runCount += 1;
        await onRunId("run-original");
        return { outcome: "failed", error: { code: "agent-failed", message: "test cleanup" }, runId: "run-original" };
      },
      onEvent: (event) => events.push(event)
    });

    expect(resumed).toMatchObject({ state: "reviewing", reviewId: "review-original", runId: "run-original" });
    expect(runCount).toBe(1);
    await waitFor(() => events.some((event) => event.reviewId === "review-original" && event.status.state === "review-failed"));
    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "input-1" })).toMatchObject({
      reviewId: "review-original"
    });
  });

  it("recovers reviewed status from an existing Agent architecture artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-legacy-"));
    const reviewed = {
      ...architectureMap([], []),
      source: "agent" as const,
      metadata: {
        source: "agent" as const,
        agentId: "codex-local" as const,
        runId: "run-existing",
        generatedAt: "2026-06-25T00:00:00.000Z",
        inputFingerprint: "scan-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "architecture-map.json"),
      `${JSON.stringify(reviewed)}\n`,
      "utf8"
    );

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "scan-1" })).toMatchObject({
      state: "reviewed",
      scanFingerprint: "scan-1",
      agentId: "codex-local",
      runId: "run-existing"
    });
  });

  it("marks a legacy architecture artifact without an input fingerprint stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-legacy-stale-"));
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "architecture-map.json"),
      `${JSON.stringify(architectureMap([], []))}\n`,
      "utf8"
    );

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "scan-1" })).toMatchObject({
      state: "stale"
    });
  });

  it("keeps a local architecture artifact current when its input fingerprint matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-local-current-"));
    const local = {
      ...architectureMap([], []),
      metadata: {
        source: "local" as const,
        generatedAt: "2026-06-25T00:00:00.000Z",
        inputFingerprint: "scan-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "architecture-map.json"),
      `${JSON.stringify(local)}\n`,
      "utf8"
    );

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "scan-1" })).toMatchObject({
      state: "local",
      scanFingerprint: "scan-1"
    });
  });

  it("does not let a legacy local review status hide a stale architecture artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-local-status-stale-"));
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "architecture-map.json"),
      `${JSON.stringify(architectureMap([], []))}\n`,
      "utf8"
    );
    await writeArchitectureReviewStatus(root, { state: "local", scanFingerprint: "scan-1", inputFingerprint: "scan-1" });

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "scan-1" })).toMatchObject({
      state: "stale"
    });
  });

  it("does not let a stored local status hide a current Agent architecture artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-local-status-reviewed-"));
    const reviewed = {
      ...architectureMap([], []),
      source: "agent" as const,
      metadata: {
        source: "agent" as const,
        agentId: "codex-local" as const,
        runId: "run-1",
        generatedAt: "2026-06-25T00:00:00.000Z",
        inputFingerprint: "scan-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "architecture-map.json"),
      `${JSON.stringify(reviewed)}\n`,
      "utf8"
    );
    await writeArchitectureReviewStatus(root, { state: "local", scanFingerprint: "scan-1", inputFingerprint: "scan-1" });

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "scan-1" })).toMatchObject({
      state: "reviewed",
      agentId: "codex-local",
      runId: "run-1"
    });
  });

  it.each([
    { name: "reviewing", storedState: "reviewing" as const, source: "agent" as const, metadata: {}, expectedState: "reviewed" as const },
    { name: "review-failed", storedState: "review-failed" as const, source: "agent" as const, metadata: {}, expectedState: "reviewed" as const },
    { name: "reviewed", storedState: "reviewed" as const, source: "agent" as const, metadata: {}, expectedState: "reviewed" as const },
    { name: "local map", storedState: "reviewing" as const, source: "local" as const, metadata: {}, expectedState: "reviewing" as const },
    { name: "different review", storedState: "reviewing" as const, source: "agent" as const, metadata: { reviewId: "review-old" }, expectedState: "reviewing" as const },
    { name: "missing review id", storedState: "reviewing" as const, source: "agent" as const, metadata: { reviewId: undefined }, expectedState: "reviewing" as const },
    { name: "missing run id", storedState: "reviewing" as const, source: "agent" as const, metadata: { runId: undefined }, expectedState: "reviewing" as const },
    { name: "missing agent id", storedState: "reviewing" as const, source: "agent" as const, metadata: { agentId: undefined }, expectedState: "reviewing" as const }
  ])("derives effective state from artifact identity when stored state is $name", async ({ storedState, source, metadata, expectedState }) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-effective-state-"));
    const flowweaveRoot = join(root, ".flowweave");
    await mkdir(flowweaveRoot, { recursive: true });
    await writeFile(
      join(flowweaveRoot, "architecture-map.json"),
      `${JSON.stringify(reviewArtifact(source, metadata))}\n`,
      "utf8"
    );
    await writeArchitectureReviewStatus(root, reviewStatus(storedState));

    const status = await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "input-1" });

    expect(status.state).toBe(expectedState);
    if (expectedState === "reviewed") {
      expect(status).toMatchObject({
        projectId: "project-1",
        artifactTarget: "architecture-map",
        startedAt: "2026-06-25T00:00:00.000Z",
        completedAt: "2026-06-25T00:00:00.000Z"
      });
      if (storedState === "reviewed") {
        expect(status.diff).toEqual({
          modules: { added: 1, removed: 0, modified: 0 },
          relationships: { added: 0, removed: 0, modified: 0 }
        });
      } else {
        expect(status.diff).toBeUndefined();
      }
      expect(status.error).toBeUndefined();
    }
  });

  it("keeps a different stored fingerprint stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-effective-stale-"));
    await writeArchitectureReviewStatus(root, {
      ...reviewStatus("reviewing"),
      scanFingerprint: "scan-old",
      inputFingerprint: "input-old"
    });

    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "input-1" })).toMatchObject({
      state: "stale",
      reviewId: "review-1"
    });
  });

  it("does not mark a review failed when its matching Agent map is already persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-already-persisted-"));
    const flowweaveRoot = join(root, ".flowweave");
    await mkdir(flowweaveRoot, { recursive: true });
    await writeFile(join(flowweaveRoot, "architecture-map.json"), JSON.stringify(reviewArtifact("agent", {})), "utf8");
    await writeArchitectureReviewStatus(root, reviewStatus("reviewing"));

    const failed = await markArchitectureReviewFailedIfCurrent(
      root,
      reviewIdentity(),
      { code: "persistence-failed", message: "late failure" }
    );

    expect(failed).toBe(false);
    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "input-1" })).toMatchObject({
      state: "reviewed",
      reviewId: "review-1",
      runId: "run-1"
    });
  });

  it.each([1, 2])("preserves a valid Agent map when %i architecture status writes fail", async (failures) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-status-write-failure-"));
    const flowweaveRoot = join(root, ".flowweave");
    await mkdir(flowweaveRoot, { recursive: true });
    const local = {
      ...architectureMap([], []),
      metadata: { source: "local" as const, scanFingerprint: "scan-1", inputFingerprint: "input-1" }
    };
    const agentMap = reviewArtifact("agent", {});
    await writeFile(join(flowweaveRoot, "project.json"), JSON.stringify({ scanFingerprint: "scan-1" }), "utf8");
    await writeFile(join(flowweaveRoot, "architecture-local.json"), JSON.stringify(local), "utf8");
    await writeArchitectureReviewStatus(root, reviewStatus("reviewing"));

    const statusPath = join(flowweaveRoot, "architecture-review.json");
    const adoption = await adoptArchitectureReview({
      ...reviewIdentity(),
      projectPath: root,
      runId: "run-1",
      architectureMap: agentMap,
      localArchitecture: local,
      persist: async (map) => {
        await writeFile(join(flowweaveRoot, "architecture-map.json"), `${JSON.stringify(map)}\n`, "utf8");
        architectureStatusWriteFault.path = statusPath;
        architectureStatusWriteFault.failuresRemaining = failures;
      }
    });

    expect(adoption).toMatchObject({ status: "applied", stateRecovered: true, architectureMap: { source: "agent" } });
    if (failures === 2) {
      expect(adoption).toMatchObject({ warning: expect.stringContaining(root) });
      expect(adoption).toMatchObject({ warning: expect.stringContaining("review-1") });
      expect(adoption).toMatchObject({ warning: expect.stringContaining("run-1") });
      expect(adoption).toMatchObject({ warning: expect.stringContaining("Injected architecture status write failure") });
    } else {
      expect(adoption).not.toHaveProperty("warning");
    }
    expect(await readArchitectureReviewStatus(root, { scanFingerprint: "scan-1", inputFingerprint: "input-1" })).toMatchObject({
      state: "reviewed",
      reviewId: "review-1",
      runId: "run-1"
    });
  });

  it("keeps a persisted recovery warning when background completion reuses the imported map", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-reused-recovery-warning-"));
    const flowweaveRoot = join(root, ".flowweave");
    await mkdir(flowweaveRoot, { recursive: true });
    const local = {
      ...architectureMap([], []),
      rootPath: root,
      metadata: { source: "local" as const, scanFingerprint: "scan-1", inputFingerprint: "input-1" }
    };
    const agentMap = reviewArtifact("agent", {});
    const adoptionEvents: Array<{ outcome: string; message: string }> = [];
    const warning = "firstStatusWriteError=first retryStatusWriteError=second";

    await writeFile(join(flowweaveRoot, "architecture-map.json"), JSON.stringify(agentMap), "utf8");
    await writeArchitectureReviewStatus(root, {
      ...reviewIdentity(),
      state: "reviewed",
      runId: "run-1",
      startedAt: "2026-06-25T00:00:00.000Z",
      completedAt: "2026-06-25T00:00:01.000Z"
    });

    const status = await startArchitectureReview({
      ...reviewIdentity(),
      projectPath: root,
      reviewId: "review-1",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:00.000Z",
      persistLocal: async () => undefined,
      run: async (onRunId) => {
        await onRunId("run-1");
        return {
          outcome: "reviewed",
          runId: "run-1",
          architectureMap: agentMap,
          stateRecovered: true,
          warning
        };
      },
      persist: async () => undefined,
      toGraph: () => ({ nodes: [], edges: [] }),
      onEvent: () => undefined,
      onAdoption: async (_runId, outcome, message) => adoptionEvents.push({ outcome, message })
    });

    expect(status.state).toBe("reviewing");
    await waitFor(() => adoptionEvents.length > 0);

    expect(adoptionEvents).toHaveLength(1);
    expect(adoptionEvents[0]).toMatchObject({
      outcome: "applied",
      message: expect.stringContaining("Review state was recovered")
    });
    expect(adoptionEvents[0].message).toContain(warning);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for architecture review event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function architectureMap(
  modules: ArchitectureMap["modules"],
  relationships: ArchitectureMap["relationships"]
): ArchitectureMap {
  return {
    version: 2,
    projectName: "Fixture",
    rootPath: "/fixture",
    generatedAt: "2026-06-25T00:00:00.000Z",
    source: "local",
    modules,
    relationships,
    files: [],
    symbols: []
  };
}

function architectureModule(
  id: string,
  title: string,
  description: string
): ArchitectureMap["modules"][number] {
  return {
    id,
    title,
    category: "domain-service",
    nodeType: "module",
    role: description,
    description,
    files: [],
    fileRoles: [],
    symbols: [],
    evidence: [],
    risk: "unknown"
  };
}

function architectureRelationship(
  id: string,
  source: string,
  target: string,
  description: string
): ArchitectureMap["relationships"][number] {
  return {
    id,
    source,
    target,
    relation: "depends_on",
    description,
    evidence: []
  };
}

function reviewIdentity() {
  return {
    projectId: "project-1",
    artifactTarget: "architecture-map" as const,
    scanFingerprint: "scan-1",
    inputFingerprint: "input-1",
    agentId: "mock" as const,
    reviewId: "review-1"
  };
}

function reviewStatus(state: ArchitectureReviewStatus["state"]): ArchitectureReviewStatus {
  return {
    ...reviewIdentity(),
    state,
    runId: "run-1",
    startedAt: "2026-06-25T00:00:00.000Z",
    ...(state === "reviewed" ? {
      diff: {
        modules: { added: 1, removed: 0, modified: 0 },
        relationships: { added: 0, removed: 0, modified: 0 }
      }
    } : {}),
    ...(state === "review-failed" ? { error: { code: "persistence-failed" as const, message: "old failure" } } : {})
  };
}

function reviewArtifact(
  source: "agent" | "local",
  metadataOverrides: Partial<ArtifactGenerationMetadata>
): ArchitectureMap {
  return {
    ...architectureMap([], []),
    source,
    metadata: {
      source,
      agentId: source === "agent" ? "mock" : undefined,
      runId: source === "agent" ? "run-1" : undefined,
      reviewId: source === "agent" ? "review-1" : undefined,
      generatedAt: "2026-06-25T00:00:01.000Z",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      fileCoverage: 1,
      evidenceCoverage: 1,
      ...metadataOverrides
    }
  };
}

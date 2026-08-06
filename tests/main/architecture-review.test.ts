import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareArchitectureMaps,
  readArchitectureReviewStatus,
  startArchitectureReview,
  writeArchitectureReviewStatus
} from "../../src/main/services/architecture-review.service";
import type { ArchitectureMap } from "../../src/types";

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
    const local = architectureMap([architectureModule("local", "Local", "Local")], []);
    const reviewed: ArchitectureMap = {
      ...architectureMap([architectureModule("reviewed", "Reviewed", "Reviewed")], []),
      source: "agent",
      metadata: {
        source: "agent",
        agentId: "mock",
        runId: "run-1",
        generatedAt: "2026-06-25T00:00:00.000Z",
        inputFingerprint: "scan-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];

    const initial = await startArchitectureReview({
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath: root,
      reviewId: "review-1",
      scanFingerprint: "scan-1",
      agentId: "mock",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:00.000Z",
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
    expect(await readArchitectureReviewStatus(root, "scan-1")).toMatchObject({
      state: "reviewed",
      reviewId: "review-1",
      runId: "run-1"
    });
    expect(events.at(-1)).toMatchObject({
      status: { state: "reviewed" },
      architectureMap: { modules: [{ id: "reviewed" }] }
    });
  });

  it("marks persisted review state stale when the scan fingerprint changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-review-stale-"));
    const local = architectureMap([], []);

    await startArchitectureReview({
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath: root,
      reviewId: "review-stale",
      scanFingerprint: "scan-old",
      agentId: "mock",
      localArchitecture: local,
      startedAt: "2026-06-25T00:00:00.000Z",
      persist: async () => undefined,
      toGraph: () => ({ nodes: [], edges: [] }),
      run: async () => ({
        outcome: "failed",
        error: { code: "agent-failed", message: "failed" }
      }),
      onEvent: () => undefined
    });

    expect(await readArchitectureReviewStatus(root, "scan-new")).toMatchObject({
      state: "stale",
      reviewId: "review-stale",
      scanFingerprint: "scan-old"
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

    expect(await readArchitectureReviewStatus(root, "scan-1")).toMatchObject({
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

    expect(await readArchitectureReviewStatus(root, "scan-1")).toMatchObject({
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

    expect(await readArchitectureReviewStatus(root, "scan-1")).toMatchObject({
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
    await writeArchitectureReviewStatus(root, { state: "local" });

    expect(await readArchitectureReviewStatus(root, "scan-1")).toMatchObject({
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
    await writeArchitectureReviewStatus(root, { state: "local", scanFingerprint: "scan-1" });

    expect(await readArchitectureReviewStatus(root, "scan-1")).toMatchObject({
      state: "reviewed",
      agentId: "codex-local",
      runId: "run-1"
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for architecture review event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

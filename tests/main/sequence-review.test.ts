import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareSequenceBundles,
  readSequenceReviewStatus,
  startSequenceReview,
  writeSequenceReviewStatus
} from "../../src/main/services/sequence-review.service";
import type { SequenceDiagramBundle } from "../../src/types";

describe("sequence-review.service", () => {
  it("summarizes participant and message changes", () => {
    const local = bundle(["client", "removed"], ["request", "removed"]);
    const reviewed = bundle(["client", "added"], ["request", "added"]);
    reviewed.architectural.participants[0].description = "Agent reviewed client.";
    reviewed.architectural.messages[0].label = "Agent reviewed request";

    expect(compareSequenceBundles(local, reviewed)).toEqual({
      participants: { added: 1, removed: 1, modified: 1 },
      messages: { added: 1, removed: 1, modified: 1 }
    });
  });

  it("persists reviewing state and publishes the reviewed bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-"));
    const local = bundle(["client"], ["request"]);
    const reviewed = {
      ...bundle(["client", "service"], ["request", "response"]),
      source: "agent" as const,
      metadata: {
        source: "agent" as const,
        agentId: "mock" as const,
        runId: "run-1",
        generatedAt: "2026-06-25T00:00:00.000Z",
        inputFingerprint: "scan-1",
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    const events: import("../../src/types").SequenceReviewEvent[] = [];

    const initial = await startSequenceReview({
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath: root,
      reviewId: "sequence-review-1",
      scanFingerprint: "scan-1",
      agentId: "mock",
      localBundle: local,
      startedAt: "2026-06-25T00:00:00.000Z",
      persist: async (value) => {
        await mkdir(join(root, ".flowweave"), { recursive: true });
        await writeFile(
          join(root, ".flowweave", "sequence-diagrams.json"),
          `${JSON.stringify(value)}\n`,
          "utf8"
        );
      },
      run: async (onRunId) => {
        await onRunId("run-1");
        return { outcome: "reviewed", bundle: reviewed, runId: "run-1" };
      },
      onEvent: (event) => events.push(event)
    });

    expect(initial.state).toBe("reviewing");
    await waitFor(() => events.some((event) => event.status.state === "reviewed"));
    expect(await readSequenceReviewStatus(root, "scan-1")).toMatchObject({
      state: "reviewed",
      reviewId: "sequence-review-1",
      runId: "run-1"
    });
    expect(events.at(-1)).toMatchObject({
      status: { state: "reviewed" },
      bundle: { source: "agent" }
    });
  });

  it("marks a legacy sequence bundle without an input fingerprint stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-legacy-stale-"));
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "sequence-diagrams.json"),
      `${JSON.stringify(bundle(["client"], ["request"]))}\n`,
      "utf8"
    );

    expect(await readSequenceReviewStatus(root, "scan-1")).toMatchObject({
      state: "stale"
    });
  });

  it("keeps a local sequence bundle current when its input fingerprint matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-local-current-"));
    const local = {
      ...bundle(["client"], ["request"]),
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
      join(root, ".flowweave", "sequence-diagrams.json"),
      `${JSON.stringify(local)}\n`,
      "utf8"
    );

    expect(await readSequenceReviewStatus(root, "scan-1")).toMatchObject({
      state: "local",
      scanFingerprint: "scan-1"
    });
  });

  it("does not let a legacy local review status hide a stale sequence bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-local-status-stale-"));
    await mkdir(join(root, ".flowweave"), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "sequence-diagrams.json"),
      `${JSON.stringify(bundle(["client"], ["request"]))}\n`,
      "utf8"
    );
    await writeSequenceReviewStatus(root, { state: "local" });

    expect(await readSequenceReviewStatus(root, "scan-1")).toMatchObject({
      state: "stale"
    });
  });

  it("does not let a stored local status hide a current Agent sequence bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-local-status-reviewed-"));
    const reviewed = {
      ...bundle(["client"], ["request"]),
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
      join(root, ".flowweave", "sequence-diagrams.json"),
      `${JSON.stringify(reviewed)}\n`,
      "utf8"
    );
    await writeSequenceReviewStatus(root, { state: "local", scanFingerprint: "scan-1" });

    expect(await readSequenceReviewStatus(root, "scan-1")).toMatchObject({
      state: "reviewed",
      agentId: "codex-local",
      runId: "run-1"
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sequence review event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function bundle(participantIds: string[], messageIds: string[]): SequenceDiagramBundle {
  const participants = participantIds.map((id) => ({
    id,
    title: id,
    kind: "component" as const,
    description: `${id} participant`
  }));
  return {
    version: 2,
    projectName: "Fixture",
    rootPath: "/fixture",
    generatedAt: "2026-06-25T00:00:00.000Z",
    source: "local",
    architectural: {
      id: "architectural-sequence",
      title: "Architectural Sequence Diagram",
      kind: "architectural",
      summary: "Fixture",
      participants,
      messages: messageIds.map((id, index) => ({
        id,
        sequence: index + 1,
        from: participants[0]?.id ?? "client",
        to: participants[1]?.id ?? participants[0]?.id ?? "client",
        kind: "sync",
        label: id
      }))
    }
  };
}

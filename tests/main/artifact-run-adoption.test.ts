import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ArchitectureMap, ToolRunResult } from "../../src/types";
import { adoptArtifactRun } from "../../src/main/services/artifact-run-adoption.service";
import { buildArchitectureInputFingerprint } from "../../src/main/services/architecture-analysis.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { buildSemanticIndex, semanticIndexToStructureFacts } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { selectRepresentativeStructureFacts } from "../../src/main/services/structure-extractor.service";
import { writeSequenceReviewStatus } from "../../src/main/services/sequence-review.service";

const architectureAdoptionState = vi.hoisted(() => ({ stateRecovered: false, warning: "" }));

vi.mock("../../src/main/services/architecture-review.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/services/architecture-review.service")>();
  return {
    ...actual,
    adoptArchitectureReview: async (input: import("../../src/main/services/architecture-review.service").AdoptArchitectureReviewInput) => ({
      status: "applied" as const,
      architectureMap: input.architectureMap,
      stateRecovered: architectureAdoptionState.stateRecovered,
      warning: architectureAdoptionState.warning || undefined
    })
  };
});

describe("artifact-run-adoption.service", () => {
  it("preserves architecture state recovery warnings in the run adoption result", async () => {
    const root = await createProjectFixture();
    const project = await scanProject(root);
    if (!project.scanFingerprint) throw new Error("Project scan did not produce a scan fingerprint.");
    const { index } = await buildSemanticIndex(project);
    const inputFingerprint = buildArchitectureInputFingerprint(project.scanFingerprint, index);
    const localArchitecture: ArchitectureMap = {
      version: 2,
      projectName: project.projectName,
      rootPath: root,
      generatedAt: "2026-09-21T00:00:00.000Z",
      source: "local",
      metadata: { source: "local", scanFingerprint: project.scanFingerprint, inputFingerprint },
      modules: [],
      relationships: [],
      files: [],
      symbols: []
    };
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), JSON.stringify(localArchitecture), "utf8");

    architectureAdoptionState.stateRecovered = true;
    architectureAdoptionState.warning = "firstStatusWriteError=first retryStatusWriteError=second";
    const result: Partial<ToolRunResult> = {
      id: "architecture-run-recovered",
      projectId: "project-1",
      toolId: "mock",
      status: "completed",
      projectPath: root,
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: project.scanFingerprint,
      inputFingerprint,
      reviewId: "architecture-review-recovered"
    };

    const adoption = await adoptArtifactRun(root, result, JSON.stringify({ modules: [], findings: [] }), "auto");

    expect(adoption).toMatchObject({
      status: "applied",
      stateRecovered: true,
      warning: "firstStatusWriteError=first retryStatusWriteError=second",
      message: expect.stringContaining("firstStatusWriteError=first retryStatusWriteError=second")
    });
  });

  it("surfaces an unreadable architecture map during sequence adoption", async () => {
    const root = await createProjectFixture();
    const project = await scanProject(root);
    if (!project.scanFingerprint) throw new Error("Project scan did not produce a scan fingerprint.");

    const reviewId = "sequence-review-unreadable-map";
    const runId = "sequence-run-unreadable-map";
    await writeSequenceReviewStatus(root, {
      state: "reviewing",
      reviewId,
      scanFingerprint: project.scanFingerprint,
      agentId: "mock",
      runId
    });

    const architectureMapPath = join(root, FLOWWEAVE_DIR, "architecture-map.json");
    await writeFile(architectureMapPath, "{", "utf8");
    const result: Partial<ToolRunResult> = {
      id: runId,
      projectId: "project-1",
      toolId: "mock",
      status: "completed",
      projectPath: root,
      purpose: "artifact-analysis",
      artifactTarget: "sequence-diagrams",
      scanFingerprint: project.scanFingerprint,
      inputFingerprint: project.scanFingerprint,
      reviewId
    };

    await expect(
      adoptArtifactRun(root, result, sequenceOutput("src/z-last.ts"), "auto")
    ).rejects.toThrow(`FlowWeave artifact is unreadable and was preserved: ${architectureMapPath}`);
  });

  it("validates adopted sequence evidence against all scanned source files", async () => {
    const root = await createProjectFixture();
    const project = await scanProject(root);
    if (!project.scanFingerprint) throw new Error("Project scan did not produce a scan fingerprint.");

    const { index } = await buildSemanticIndex(project);
    const facts = semanticIndexToStructureFacts(project, index);
    const representativeFacts = selectRepresentativeStructureFacts(facts, 40);
    expect(facts.files.some((file) => file.path === "src/z-last.ts")).toBe(true);
    expect(representativeFacts.some((file) => file.path === "src/z-last.ts")).toBe(false);

    const reviewId = "sequence-review-1";
    const runId = "sequence-run-1";
    await writeSequenceReviewStatus(root, {
      state: "reviewing",
      reviewId,
      scanFingerprint: project.scanFingerprint,
      agentId: "mock",
      runId
    });

    const result: Partial<ToolRunResult> = {
      id: runId,
      projectId: "project-1",
      toolId: "mock",
      status: "completed",
      projectPath: root,
      startedAt: "2026-09-21T00:00:00.000Z",
      completedAt: "2026-09-21T00:00:01.000Z",
      executionMode: "execute",
      purpose: "artifact-analysis",
      artifactTarget: "sequence-diagrams",
      scanFingerprint: project.scanFingerprint,
      inputFingerprint: project.scanFingerprint,
      reviewId,
      events: []
    };

    const validAdoption = await adoptArtifactRun(root, result, sequenceOutput("src/z-last.ts"), "auto");
    expect(validAdoption.status).toBe("applied");

    const missingFileAdoption = await adoptArtifactRun(root, result, sequenceOutput("src/missing.ts"), "auto");
    expect(missingFileAdoption).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("no valid source evidence")
    });
  });
});

async function createProjectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flowweave-artifact-adoption-"));
  const sourceRoot = join(root, "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "main.ts"), "export function main() { return lateStage(); }\n", "utf8");
  for (let index = 0; index < 42; index += 1) {
    await writeFile(join(sourceRoot, `a-${String(index).padStart(2, "0")}.ts`), `export function value${index}() { return ${index}; }\n`, "utf8");
  }
  await writeFile(join(sourceRoot, "z-last.ts"), "export function lateStage() { return true; }\n", "utf8");
  return root;
}

function sequenceOutput(evidencePath: string): string {
  return JSON.stringify({
    architectural: {
      id: "architectural-sequence",
      title: "Architectural Sequence Diagram",
      kind: "architectural",
      summary: "The application entry passes the request to the late stage service.",
      participants: [
        { id: "main-entry", title: "Main Entry", kind: "component", description: "Starts the workflow.", filePath: "src/main.ts", symbol: "main" },
        { id: "late-stage", title: "Late Stage", kind: "service", description: "Handles the final stage.", filePath: evidencePath, symbol: "lateStage" }
      ],
      messages: [
        {
          id: "main-to-late-stage",
          sequence: 1,
          from: "main-entry",
          to: "late-stage",
          kind: "sync",
          label: "Run late stage",
          description: "The entry point calls the late stage service.",
          evidence: [{ filePath: evidencePath, symbol: "lateStage", detail: "The entry point delegates to lateStage." }]
        }
      ],
      evidence: []
    }
  });
}

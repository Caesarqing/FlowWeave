import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeArchitecture } from "../../src/main/services/architecture-analysis.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { generateSequenceDiagrams } from "../../src/main/services/sequence-diagram.service";
import { inferGraphFromProject } from "../../src/main/services/task-generator.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { writeFlowWeaveProject } from "../../src/main/storage/flowweave-store";

describe("full project flow", () => {
  it("scans, indexes, visualizes, and generates architecture and sequence artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-e2e-"));
    await mkdir(join(root, "client"), { recursive: true });
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(
      join(root, "client", "UserPage.tsx"),
      "export const loadUser = (id: string) => fetch(`/api/users/${id}`);\n",
      "utf8"
    );
    await writeFile(
      join(root, "server", "users.ts"),
      "router.get('/api/users/:id', getUser);\nexport function getUser() { return database.user.findUnique(); }\n",
      "utf8"
    );

    const project = await scanProject(root);
    const semantic = await buildSemanticIndex(project);
    const graph = await inferGraphFromProject(project);
    await writeFlowWeaveProject(
      root,
      project,
      graph.nodes,
      graph.edges,
      project.scanFingerprint ?? ""
    );
    const architecture = await analyzeArchitecture(project, "mock");
    const sequences = await generateSequenceDiagrams(project, "mock");

    expect(semantic.index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "http",
        sourceFile: "client/UserPage.tsx",
        targetFile: "server/users.ts"
      })
    ]));
    expect(architecture.outcome).toBe("generated");
    if (sequences.outcome === "failed") throw new Error(sequences.error.message);
    expect(sequences.outcome).toBe("generated");

    const artifactRoot = join(root, ".flowweave");
    const projectArtifact = JSON.parse(await readFile(join(artifactRoot, "project.json"), "utf8")) as {
      scanFingerprint: string;
    };
    const canvasArtifact = JSON.parse(await readFile(join(artifactRoot, "canvas", "main.canvas.json"), "utf8")) as {
      version: number;
      scanFingerprint: string;
    };
    const architectureArtifact = JSON.parse(await readFile(join(artifactRoot, "architecture-map.json"), "utf8")) as {
      metadata: { inputFingerprint: string };
    };
    const sequenceArtifact = JSON.parse(await readFile(join(artifactRoot, "sequence-diagrams.json"), "utf8")) as {
      metadata: { inputFingerprint: string };
    };

    expect(canvasArtifact.version).toBe(3);
    expect(canvasArtifact.scanFingerprint).toBe(projectArtifact.scanFingerprint);
    expect(architectureArtifact.metadata.inputFingerprint).toBe(projectArtifact.scanFingerprint);
    expect(sequenceArtifact.metadata.inputFingerprint).toBe(projectArtifact.scanFingerprint);
    await expect(readFile(join(artifactRoot, "index", "semantic-index.json"), "utf8")).resolves.toContain('"version": 1');
    await expect(readFile(join(artifactRoot, "tasks", "current.task.md"), "utf8")).resolves.toContain("Acceptance Criteria");
  });
});

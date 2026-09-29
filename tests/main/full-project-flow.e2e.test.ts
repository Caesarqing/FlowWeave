import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeArchitecture
} from "../../src/main/services/architecture-analysis.service";
import { generateSequenceDiagrams } from "../../src/main/services/sequence-diagram.service";
import { generateProject } from "../../src/main/services/project-generation.service";

describe("full project flow", () => {
  it("scans, indexes, visualizes, and generates architecture and sequence artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-e2e-"));
    await mkdir(join(root, "client"), { recursive: true });
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(
      join(root, "client", "UserPage.tsx"),
      'import { getUser } from "../server/users";\nexport const loadUser = () => { fetch("https://users.example/api/users"); return getUser(); };\n',
      "utf8"
    );
    await writeFile(
      join(root, "server", "users.ts"),
      "export function getUser() { return { id: 1 }; }\n",
      "utf8"
    );

    const generated = await generateProject(root, {});
    if (generated.status !== "committed") throw new Error("Expected a committed project generation.");
    const { project, index, graph } = generated;
    const architecture = await analyzeArchitecture(project, "mock", { semanticIndex: index });
    const sequences = await generateSequenceDiagrams(project, "mock");

    expect(index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "http",
        sourceFile: "client/UserPage.tsx",
        targetRef: expect.objectContaining({ kind: "resource" })
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
      detailedDesign?: unknown;
    };

    expect(canvasArtifact.version).toBe(6);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges).toContainEqual(expect.objectContaining({ relation: "calls", source: expect.any(String), target: expect.any(String) }));
    expect(canvasArtifact.scanFingerprint).toBe(projectArtifact.scanFingerprint);
    expect(architectureArtifact.metadata.inputFingerprint).toBe(generated.localArchitecture.metadata?.inputFingerprint);
    expect(sequenceArtifact.metadata.inputFingerprint).toBe(projectArtifact.scanFingerprint);
    expect(sequenceArtifact.detailedDesign).toBeUndefined();
    await expect(readFile(join(artifactRoot, "index", "semantic-index.json"), "utf8")).resolves.toContain('"version": 5');
    await expect(readFile(join(artifactRoot, "tasks", "current.task.md"), "utf8")).resolves.toContain("Acceptance Criteria");
  });
});

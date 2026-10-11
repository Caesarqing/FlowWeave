import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeArchitecture } from "../../src/main/services/architecture-analysis.service";
import { generateSequenceDiagrams } from "../../src/main/services/sequence-diagram.service";
import { generateProject } from "../../src/main/services/project-generation.service";
import { enableProjectAgentConnection, getProjectAgentContextPath } from "../../src/main/services/project-agent-connection.service";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import { writeCurrentTaskArtifact } from "../../src/main/services/task-artifact.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { withArchitectureArtifactLock } from "../../src/main/services/architecture-review.service";
import { readProjectProtocolCanvas, readProjectProtocolOverview, readProjectProtocolSnapshot } from "../../src/main/storage/flowweave-store";

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

    const modificationInstruction = "Keep the user lookup flow connected to its API source.";
    const modificationDocs = await writeModificationDocs(root, {
      canvas: generated.canvas,
      sequence: sequences.bundle,
      sequenceInstruction: modificationInstruction
    });
    const modificationGuidance = await readFile(modificationDocs.guidancePath, "utf8");
    const modificationContext = JSON.parse(await readFile(modificationDocs.contextPath, "utf8")) as {
      source: string;
      project: { scanFingerprint?: string };
      delta: { sequenceInstruction?: string };
      artifactReferences: string[];
    };

    const artifactRoot = join(root, ".flowweave");
    const manifest = JSON.parse(await readFile(join(artifactRoot, "generation.json"), "utf8")) as { storageProtocol: number; generationId: string; inputFingerprint: string };
    const snapshot = await readProjectProtocolSnapshot(root);
    const overview = await readProjectProtocolOverview(root);
    const canvas = await readProjectProtocolCanvas(root);
    const sequenceArtifact = JSON.parse(await readFile(join(artifactRoot, "sequence-diagrams.json"), "utf8")) as {
      metadata: { inputFingerprint: string };
      detailedDesign?: unknown;
    };

    expect(manifest.storageProtocol).toBe(7);
    expect(snapshot?.schemaVersion).toBe(1);
    expect(overview?.generationId).toBe(manifest.generationId);
    expect(canvas?.generation?.requestId).toBe(manifest.generationId);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges).toContainEqual(expect.objectContaining({ relation: "calls", source: expect.any(String), target: expect.any(String) }));
    expect(snapshot?.project.scanFingerprint).toBe(generated.project.scanFingerprint);
    expect(snapshot?.localArchitecture.metadata?.inputFingerprint).toBe(generated.localArchitecture.metadata?.inputFingerprint);
    expect(modificationContext.source).toBe("FlowWeave");
    expect(modificationContext.project.scanFingerprint).toBe(generated.project.scanFingerprint);
    expect(modificationContext.delta.sequenceInstruction).toBe(modificationInstruction);
    expect(modificationContext.artifactReferences).toContain(".flowweave/static-snapshot.json");
    expect(modificationGuidance).toContain(modificationInstruction);
    expect(sequenceArtifact.metadata.inputFingerprint).toBe(generated.project.scanFingerprint);
    expect(sequenceArtifact.detailedDesign).toBeUndefined();
    await expect(readFile(join(artifactRoot, "index", "semantic-index.json"), "utf8")).resolves.toContain('"version": 5');
    await expect(readFile(join(artifactRoot, "tasks", "current.task.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const taskPaths = await withArchitectureArtifactLock(root, () =>
      writeCurrentTaskArtifact(root, generated.generation.requestId, canvas?.userRevision ?? 0)
    );
    const task = JSON.parse(await readFile(taskPaths.taskPath, "utf8")) as import("../../src/types").CodeflowTask;
    const taskMarkdown = await readFile(taskPaths.markdownPath, "utf8");

    const connection = await enableProjectAgentConnection(root);
    const agentContext = await readFile(getProjectAgentContextPath(root), "utf8");

    expect(connection.state).toBe("ready");
    expect(task.generation).toEqual({ requestId: manifest.generationId, inputFingerprint: manifest.inputFingerprint });
    expect(task.inputFingerprint).toBe(generated.project.scanFingerprint);
    expect(task.modules.some((module) => module.files.includes("client/UserPage.tsx"))).toBe(true);
    expect(taskMarkdown).toContain("client/UserPage.tsx");
    await expect(readFile(taskPaths.markdownPath, "utf8")).resolves.toBe(taskMarkdown);
    expect(agentContext).toContain(`Scan fingerprint: ${generated.project.scanFingerprint}`);
    expect(agentContext).toContain(".flowweave/tasks/current.task.json");
    expect(agentContext).not.toContain(".flowweave/tasks/current.task.md");
  });
});

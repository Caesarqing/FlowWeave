import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ArchitectureMap,
  CanvasUserStateV1,
  CodeflowCanvas,
  CodeflowProject,
  GraphOverviewV1,
  ProjectGenerationManifestV7,
  StaticSnapshotV1
} from "../../src/types";
import { createCanvasUserState, createGraphOverview } from "../../src/main/services/canvas-migration.service";

export async function writeEmptyProtocolFixture(projectPath: string, scanFingerprint: string): Promise<CodeflowCanvas> {
  const generatedAt = "2026-10-01T00:00:00.000Z";
  const project: CodeflowProject = {
    version: 2,
    projectName: basename(projectPath),
    rootPath: projectPath,
    generatedAt,
    git: { isRepo: false },
    summary: { totalFiles: 0, totalFolders: 0, languages: {} },
    files: [],
    scanFingerprint
  };
  const canvas: CodeflowCanvas = {
    id: "main",
    title: project.projectName,
    projectPath,
    generatedAt,
    scanFingerprint,
    artifactState: "current",
    nodes: [],
    edges: []
  };
  return writeProtocolFixture(projectPath, project, canvas);
}

export async function writeCanvasProtocolFixture(projectPath: string, canvas: CodeflowCanvas): Promise<CodeflowCanvas> {
  const project: CodeflowProject = {
    version: 2,
    projectName: canvas.title,
    rootPath: projectPath,
    generatedAt: canvas.generatedAt,
    git: { isRepo: false },
    summary: { totalFiles: 0, totalFolders: 0, languages: {} },
    files: [],
    scanFingerprint: canvas.scanFingerprint ?? "protocol-fixture-input"
  };
  return writeProtocolFixture(projectPath, project, { ...canvas, projectPath });
}

export async function writeArchitectureProtocolFixture(
  projectPath: string,
  sourceProject: CodeflowProject,
  sourceCanvas: CodeflowCanvas,
  sourceArchitecture: ArchitectureMap
): Promise<{ canvas: CodeflowCanvas; architecture: ArchitectureMap }> {
  const canvas = await writeProtocolFixture(projectPath, sourceProject, sourceCanvas);
  const architecture = { ...sourceArchitecture, generation: canvas.generation };
  const snapshotPath = join(projectPath, ".flowweave", "static-snapshot.json");
  const overviewPath = join(projectPath, ".flowweave", "graph-overview.json");
  const manifestPath = join(projectPath, ".flowweave", "generation.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as StaticSnapshotV1;
  const overview = JSON.parse(await readFile(overviewPath, "utf8")) as GraphOverviewV1;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectGenerationManifestV7;
  const snapshotContent = jsonText({ ...snapshot, localArchitecture: architecture });
  const overviewContent = jsonText({
    ...overview,
    relationDiagnostics: architecture.relationDiagnostics ?? [],
    resources: architecture.resources ?? []
  });
  await writeFile(snapshotPath, snapshotContent, "utf8");
  await writeFile(overviewPath, overviewContent, "utf8");
  await writeFile(manifestPath, jsonText({
    ...manifest,
    artifacts: {
      ...manifest.artifacts,
      staticSnapshot: contentHash(snapshotContent),
      graphOverview: contentHash(overviewContent)
    }
  }), "utf8");
  return { canvas, architecture };
}

export async function writeProtocolFixture(
  projectPath: string,
  sourceProject: CodeflowProject,
  sourceCanvas: CodeflowCanvas,
  userCanvas: CodeflowCanvas = sourceCanvas
): Promise<CodeflowCanvas> {
  const flowweaveRoot = join(projectPath, ".flowweave");
  const inputFingerprint = sourceProject.scanFingerprint ?? "protocol-fixture-input";
  const rulesVersion = "protocol-fixture-rules-v1";
  const generationId = createHash("sha256").update(JSON.stringify({
    storageProtocol: 7,
    rulesVersion,
    inputFingerprint
  })).digest("hex");
  const generation = { requestId: generationId, inputFingerprint };
  const project = { ...sourceProject, generation };
  const generatedCanvas: CodeflowCanvas = {
    ...sourceCanvas,
    generation,
    inputFingerprint,
    scanFingerprint: sourceProject.scanFingerprint,
    userRevision: 0
  };
  const canvas: CodeflowCanvas = {
    ...userCanvas,
    generation,
    inputFingerprint,
    scanFingerprint: sourceProject.scanFingerprint,
    userRevision: 0
  };
  const architecture: ArchitectureMap = {
    version: 3,
    source: "local",
    generatedAt: generatedCanvas.generatedAt,
    modules: [],
    relationships: [],
    metadata: {
      source: "local",
      scanFingerprint: sourceProject.scanFingerprint,
      inputFingerprint
    },
    generation
  };
  const snapshot: StaticSnapshotV1 = {
    schemaVersion: 1,
    generationId,
    inputFingerprint,
    generatedAt: canvas.generatedAt,
    project,
    semanticIndex: {
      generation, version: 5, generatorVersion: "protocol-fixture-analyzer-v1", projectName: project.projectName,
      rootPath: projectPath, generatedAt: canvas.generatedAt, scanFingerprint: canvas.scanFingerprint ?? "",
      files: [...new Set(sourceCanvas.nodes.flatMap((node) => node.files))].map((path) => ({
        path, size: 0, modifiedAt: canvas.generatedAt, contentHash: "fixture", cacheKey: "fixture",
        analyzerId: "fixture", analysisDepth: "semantic" as const, status: "parsed" as const,
        diagnostics: [], httpEndpoints: [], renderTargets: []
      })),
      symbols: [], relations: [], httpEndpoints: [], diagnostics: []
    },
    localArchitecture: architecture
  };
  const overview: GraphOverviewV1 = {
    ...createGraphOverview(generatedCanvas, generationId),
    inputFingerprint,
    project,
    relationDiagnostics: [],
    resources: []
  };
  const userState: CanvasUserStateV1 = createCanvasUserState(generatedCanvas, canvas, generationId, 0);
  const files = {
    "static-snapshot.json": jsonText(snapshot),
    "graph-overview.json": jsonText(overview),
    "canvas/user-state.json": jsonText(userState)
  };
  const manifest: ProjectGenerationManifestV7 = {
    storageProtocol: 7,
    generationId,
    inputFingerprint,
    rulesVersion,
    analyzerVersion: "protocol-fixture-analyzer-v1",
    committedAt: canvas.generatedAt,
    artifacts: {
      staticSnapshot: contentHash(files["static-snapshot.json"]),
      graphOverview: contentHash(files["graph-overview.json"]),
      canvasUserState: contentHash(files["canvas/user-state.json"])
    }
  };
  await mkdir(join(flowweaveRoot, "canvas"), { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(join(flowweaveRoot, path), content, "utf8");
  await writeFile(join(flowweaveRoot, "generation.json"), jsonText(manifest), "utf8");
  return canvas;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import { join } from "node:path";
import type { GenerationIdentity, GraphEdge, GraphNode, TaskArtifactWriteResult } from "../../types";
import type { CodeflowTask } from "../storage/schemas";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readProjectGenerationManifest, readProjectProtocolCanvas, readProjectProtocolOverview, writeBatchAtomic } from "../storage/flowweave-store";

const GENERATOR_VERSION = "1.0.0";

export function createTaskArtifact(
  modules: GraphNode[],
  edges: GraphEdge[],
  scanFingerprint: string,
  generation: GenerationIdentity
): CodeflowTask {
  return {
    generation,
    version: 2,
    generatorVersion: GENERATOR_VERSION,
    inputFingerprint: scanFingerprint,
    artifactState: "current",
    id: `task-${Date.now()}`,
    title: "FlowWeave generated Codex task",
    generatedAt: new Date().toISOString(),
    targetTools: ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"],
    modules: modules.filter((module) => !module.resource).map((module) => ({
      id: module.id,
      title: module.title,
      kind: module.kind,
      nodeType: module.nodeType,
      risk: module.risk,
      description: module.description,
      files: module.files,
      guidance: module.guidanceDraft
    })),
    relations: edges.filter((edge) => modules.some((module) => module.id === edge.source && !module.resource) && modules.some((module) => module.id === edge.target && !module.resource)).map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      guidanceNote: edge.guidanceNote
    })),
    acceptanceCriteria: [
      "Codex changes only files listed in the selected modules unless a clear dependency requires another file.",
      "Generated changes include tests or a written explanation when tests are not applicable.",
      "Security-sensitive files require explicit human approval before modification."
    ]
  };
}

/** Caller holds the project artifact lock while validating and committing this derived artifact. */
export async function writeCurrentTaskArtifact(
  projectPath: string,
  expectedGenerationId: string,
  expectedUserRevision: number
): Promise<TaskArtifactWriteResult> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest || manifest.generationId !== expectedGenerationId) {
    throw new Error(`Task generation rejected because the project generation changed: project ${projectPath}, expected ${expectedGenerationId}, actual ${manifest?.generationId ?? "missing"}`);
  }
  const [canvas, overview] = await Promise.all([
    readProjectProtocolCanvas(projectPath),
    readProjectProtocolOverview(projectPath)
  ]);
  if (!canvas || !overview?.project) {
    throw new Error(`Task generation requires a complete committed protocol v7 project: ${projectPath}`);
  }
  if (canvas.userRevision !== expectedUserRevision) {
    throw new Error(`Task generation rejected because Canvas user state changed: project ${projectPath}, generation ${expectedGenerationId}, expected revision ${expectedUserRevision}, actual ${canvas.userRevision ?? "missing"}`);
  }
  const scanFingerprint = canvas.scanFingerprint;
  if (!scanFingerprint || scanFingerprint !== overview.scanFingerprint || overview.project.scanFingerprint !== scanFingerprint) {
    throw new Error(`Task generation rejected because the committed scan fingerprint is inconsistent: project ${projectPath}, generation ${expectedGenerationId}`);
  }

  const generation: GenerationIdentity = { requestId: manifest.generationId, inputFingerprint: manifest.inputFingerprint };
  const task = createTaskArtifact(canvas.nodes, canvas.edges, scanFingerprint, generation);
  const taskPath = join(projectPath, FLOWWEAVE_DIR, "tasks", "current.task.json");
  const markdownPath = join(projectPath, FLOWWEAVE_DIR, "tasks", "current.task.md");
  await writeBatchAtomic(projectPath, [
    { path: taskPath, content: `${JSON.stringify(task, null, 2)}\n` },
    { path: markdownPath, content: createTaskMarkdown(task) }
  ], [], async () => {
    const [currentManifest, currentCanvas] = await Promise.all([
      readProjectGenerationManifest(projectPath),
      readProjectProtocolCanvas(projectPath)
    ]);
    if (currentManifest?.generationId !== expectedGenerationId || currentCanvas?.generation?.requestId !== expectedGenerationId) {
      throw new Error(`Task generation rejected at commit because the project generation changed: project ${projectPath}, expected ${expectedGenerationId}, actual ${currentManifest?.generationId ?? "missing"}`);
    }
    if (currentCanvas.userRevision !== expectedUserRevision) {
      throw new Error(`Task generation rejected at commit because Canvas user state changed: project ${projectPath}, generation ${expectedGenerationId}, expected revision ${expectedUserRevision}, actual ${currentCanvas.userRevision}`);
    }
  });
  return { taskPath, markdownPath, generationId: expectedGenerationId, userRevision: expectedUserRevision };
}

export function createTaskMarkdown(task: CodeflowTask) {
  return `# ${task.title}

Target Agents: ${task.targetTools.join(", ")}
Generated At: ${task.generatedAt}

## Modules

${task.modules
  .map(
    (module) => `### ${module.title}

${module.description}

Files:
${module.files.map((file) => `- ${file}`).join("\n")}

Guidance:
${module.guidance}
`
  )
  .join("\n")}

## Module Relations

${task.relations
  .map(
    (relation) =>
      `- ${relation.source} -> ${relation.target} (${relation.relation})${relation.guidanceNote ? `: ${relation.guidanceNote}` : ""}`
  )
  .join("\n")}

## Acceptance Criteria

${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}
`;
}

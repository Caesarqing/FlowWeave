import type { GraphEdge, GraphNode } from "../../types";
import type { CodeflowTask } from "../storage/schemas";

const GENERATOR_VERSION = "1.0.0";

export function createTaskArtifact(
  modules: GraphNode[],
  edges: GraphEdge[],
  scanFingerprint: string
): CodeflowTask {
  return {
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

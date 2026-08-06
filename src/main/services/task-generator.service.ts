import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphEdge, GraphNode, GraphNodeType } from "../../types";
import type { CodeflowCanvas, CodeflowProject, CodeflowTask, ProjectFileNode } from "../storage/schemas";
import { collectImportReferences, flattenProjectFilePaths } from "./import-parser.service";

const MAX_INFERRED_CODE_FILES = 600;
const MAX_INFERRED_EDGES = 140;
const GENERATOR_VERSION = "1.0.0";

export function createCanvasArtifact(
  projectPath: string,
  modules: GraphNode[],
  edges: GraphEdge[] | undefined,
  scanFingerprint: string
): CodeflowCanvas {
  return {
    version: 4,
    generatorVersion: GENERATOR_VERSION,
    inputFingerprint: scanFingerprint,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: new Date().toISOString(),
    scanFingerprint,
    artifactState: "current",
    layout: {
      activeMode: "manual",
      manualPositions: Object.fromEntries(modules.map((node) => [node.id, { x: node.x, y: node.y }])),
      autoLayouts: {},
      collapsedGroups: []
    },
    nodes: modules,
    edges: edges ?? createDefaultEdges(modules)
  };
}

export function createTaskArtifact(
  modules: GraphNode[],
  edges: GraphEdge[] | undefined,
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
    modules: modules.map((module) => ({
      id: module.id,
      title: module.title,
      kind: module.kind,
      nodeType: module.nodeType,
      risk: module.risk,
      description: module.description,
      files: module.files,
      guidance: module.guidanceDraft
    })),
    relations: (edges ?? createDefaultEdges(modules)).map((edge) => ({
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

export async function inferGraphFromProject(project: CodeflowProject) {
  const flatFiles = flattenFiles(project.files);
  const groups = groupBackendFiles(flatFiles);
  const entries = [...groups.entries()];
  const fallbackEntries =
    entries.length > 0
      ? entries
      : [["project", flatFiles.filter((file) => file.type === "file").slice(0, 12).map((file) => file.path)]] as Array<[string, string[]]>;

  const nodes: GraphNode[] = fallbackEntries.map(([group, files], index) => ({
    id: toNodeId(group),
    title: toTitle(group),
    subtitle: getNodeSubtitle(group),
    kind: "module",
    nodeType: getNodeType(group),
    risk: "unknown",
    description: getNodeDescription(group, files),
    files,
    guidanceDraft: `Review the responsibility boundaries of these files around ${toTitle(group)}, and expand the modification scope only when required by its connections.`,
    status: "mapped",
    x: 120 + (index % 3) * 300,
    y: 120 + Math.floor(index / 3) * 210
  }));

  const importEdges = await inferImportEdges(project, nodes);

  return {
    nodes,
    edges: importEdges.length > 0 ? importEdges : inferFallbackEdges(nodes)
  };
}

export function createDefaultEdges(modules: GraphNode[]): CodeflowCanvas["edges"] {
  return inferFallbackEdges(modules);
}

function flattenFiles(nodes: ProjectFileNode[]) {
  const flattened: ProjectFileNode[] = [];
  function visit(node: ProjectFileNode) {
    flattened.push(node);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return flattened;
}

function groupBackendFiles(files: ProjectFileNode[]) {
  const groups = new Map<string, string[]>();
  const codeFiles = files.filter((file) => file.type === "file" && isBackendFile(file.path)).slice(0, MAX_INFERRED_CODE_FILES);

  for (const file of codeFiles) {
    const group = detectModuleGroup(file.path);
    const groupFiles = groups.get(group) ?? [];
    groupFiles.push(file.path);
    groups.set(group, groupFiles);
  }

  return new Map([...groups.entries()].sort((a, b) => scoreGroup(b[0]) - scoreGroup(a[0]) || a[0].localeCompare(b[0])));
}

function isBackendFile(path: string) {
  return /\.(ts|tsx|js|jsx|py|go|java|rb|rs|php|cs|prisma|sql)$/.test(path);
}

function detectModuleGroup(path: string) {
  const parts = path.split("/");
  const srcIndex = parts.lastIndexOf("src");
  const afterSrc = srcIndex >= 0 ? parts[srcIndex + 1] : undefined;
  if (afterSrc && !afterSrc.includes(".")) {
    return afterSrc;
  }

  if (parts.some((part) => /test|spec|__tests__/i.test(part))) {
    return "tests";
  }

  if (parts.some((part) => /prisma|migration|database|db|schema/i.test(part))) {
    return "database";
  }

  return parts[0] ?? "project";
}

function scoreGroup(group: string) {
  if (/api|route|controller|server|app/i.test(group)) return 5;
  if (/auth|user|order|payment|database|db|prisma/i.test(group)) return 4;
  if (/test|spec/i.test(group)) return 3;
  return 1;
}

async function inferImportEdges(project: CodeflowProject, nodes: GraphNode[]) {
  const codeFilePaths = flattenProjectFilePaths(project.files).filter(isBackendFile).slice(0, MAX_INFERRED_CODE_FILES);
  const fileContents = await Promise.all(
    codeFilePaths.map(async (path) => ({
      path,
      content: await readFile(join(project.rootPath, ...path.split("/")), "utf8").catch(() => "")
    }))
  );

  const groupByFile = new Map<string, string>();
  for (const node of nodes) {
    for (const file of node.files) {
      groupByFile.set(file, node.id);
    }
  }

  const existingNodeIds = new Set(nodes.map((node) => node.id));
  const importEdges: GraphEdge[] = [];
  for (const reference of collectImportReferences(fileContents, project.files)) {
      const source = groupByFile.get(reference.importer);
      const target = groupByFile.get(reference.imported);
      if (!source || !target || source === target) continue;
      if (!existingNodeIds.has(source) || !existingNodeIds.has(target)) continue;
      importEdges.push({
        id: `${source}-${target}-depends-on`,
        source,
        target,
        relation: "depends_on" as const,
        guidanceNote: `${reference.importer} imports ${reference.imported}`
      });
  }

  return dedupeEdges(importEdges).slice(0, MAX_INFERRED_EDGES);
}

function inferFallbackEdges(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const entry = nodes.find((node) => node.nodeType === "entrypoint") ?? nodes.find((node) => /api|route|controller|server|app/i.test(node.id));
  const data = nodes.find((node) => node.nodeType === "data");
  const tests = nodes.filter((node) => node.nodeType === "test");

  if (entry) {
    for (const node of nodes) {
      if (node.id !== entry.id && node.nodeType === "module") {
        edges.push({ id: `${entry.id}-${node.id}`, source: entry.id, target: node.id, relation: "calls" });
      }
    }
  }

  if (data) {
    for (const node of nodes) {
      if (node.id !== data.id && node.nodeType !== "test") {
        edges.push({ id: `${node.id}-${data.id}`, source: node.id, target: data.id, relation: "reads_writes" });
      }
    }
  }

  for (const test of tests) {
    const target = nodes.find((node) => node.id !== test.id && node.nodeType === "module");
    if (target) {
      edges.push({ id: `${target.id}-${test.id}`, source: target.id, target: test.id, relation: "tests" });
    }
  }

  return dedupeEdges(edges);
}

function dedupeEdges(edges: GraphEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}:${edge.target}:${edge.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toNodeId(group: string) {
  return group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
}

function toTitle(group: string) {
  return group
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getNodeType(group: string): GraphNodeType {
  if (/test|spec/i.test(group)) return "test";
  if (/database|db|prisma|schema|migration/i.test(group)) return "data";
  if (/api|route|controller|server|app/i.test(group)) return "entrypoint";
  return "module";
}

function getNodeSubtitle(group: string) {
  const type = getNodeType(group);
  if (type === "entrypoint") return "Request entry and orchestration";
  if (type === "data") return "Data model and persistence";
  if (type === "test") return "Testing and regression validation";
  return "Backend business module";
}

function getNodeDescription(group: string, files: string[]) {
  return `${toTitle(group)} was generated from the project scan with ${files.length} key files. Connections define the scope used for Agent planning.`;
}

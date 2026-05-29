import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAnalysisResult, ApiMap, CodeflowProject, GraphEdge, GraphNode, ModuleMap, ProjectMap, ToolId } from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { getToolAdapter } from "./agent-run.service";
import { inferGraphFromProject } from "./task-generator.service";

export async function analyzeProject(project: CodeflowProject, toolId: ToolId): Promise<AgentAnalysisResult> {
  const fallbackGraph = await inferGraphFromProject(project);
  const prompt = buildAnalysisPrompt(project);

  if (toolId === "mock") {
    const agentOutput = mockAnalysisJson(project, fallbackGraph.nodes, fallbackGraph.edges);
    const parsed = parseAnalysisJson(agentOutput);
    const result = parsed ? analysisToResult(parsed, agentOutput) : createFallbackResult(project, fallbackGraph.nodes, fallbackGraph.edges, "fallback", agentOutput);
    await writeAnalysisArtifacts(project.rootPath, result);
    return result;
  }

  try {
    const adapter = getToolAdapter(toolId);
    const detection = await adapter.detect();
    if (!detection.available) throw new Error(detection.message ?? "Tool unavailable");
    const runResult = await adapter.runPlan({
      id: `analysis-${Date.now()}`,
      projectPath: project.rootPath,
      prompt,
      executionMode: "plan"
    });
    const agentOutput = runResult.events
      .filter((event) => event.type === "stdout")
      .map((event) => event.content)
      .join("\n");
    const parsed = parseAnalysisJson(agentOutput);
    const result = parsed
      ? analysisToResult(parsed, agentOutput)
      : createFallbackResult(project, fallbackGraph.nodes, fallbackGraph.edges, "fallback", agentOutput);
    await writeAnalysisArtifacts(project.rootPath, result);
    return result;
  } catch (error) {
    const result = createFallbackResult(project, fallbackGraph.nodes, fallbackGraph.edges, "fallback", String(error));
    await writeAnalysisArtifacts(project.rootPath, result);
    return result;
  }
}

export function buildAnalysisPrompt(project: CodeflowProject) {
  const languageSummary = Object.entries(project.summary.languages)
    .map(([language, count]) => `${count} ${language}`)
    .join(", ");
  const fileTree = renderFileTree(project.files);

  return `You are analyzing a backend project. Return only JSON.

Project: ${project.projectName}
Languages: ${languageSummary || "unknown"}

File tree:
${fileTree}

Return this exact JSON shape:
{
  "projectMap": {
    "language": "string",
    "framework": "string optional",
    "entryFiles": ["path"],
    "directories": [{"path": "path", "purpose": "one sentence"}]
  },
  "moduleMap": {
    "modules": [{
      "id": "stable-id",
      "title": "Module title",
      "description": "one sentence",
      "files": ["path"],
      "dependencies": [{"target": "stable-id", "relation": "depends_on"}],
      "risk": "normal"
    }]
  },
  "apiMap": {
    "endpoints": [{"method": "GET", "path": "/path", "handler": "file#symbol", "description": "optional"}]
  }
}

Rules:
- Group files into logical backend modules by purpose.
- Only use dependency relation values: depends_on, calls, reads_writes, tests.
- Mark auth/security/payment modules as review risk.`;
}

function analysisToResult(parsed: { projectMap: ProjectMap; moduleMap: ModuleMap; apiMap?: ApiMap }, agentOutput: string): AgentAnalysisResult {
  const nodes = parsed.moduleMap.modules.map((module, index): GraphNode => ({
    id: module.id,
    title: module.title,
    subtitle: "Agent 分析模块",
    kind: "module",
    nodeType: module.files.some((file) => /test|spec/i.test(file)) ? "test" : "module",
    risk: module.risk,
    description: module.description,
    files: module.files,
    guidanceDraft: `请围绕 ${module.title} 的 Agent 分析结果执行修改，并遵守连接关系。`,
    status: "mapped",
    x: 120 + (index % 3) * 300,
    y: 120 + Math.floor(index / 3) * 210
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = parsed.moduleMap.modules.flatMap((module) =>
    module.dependencies
      .filter((dependency) => nodeIds.has(module.id) && nodeIds.has(dependency.target))
      .map((dependency) => ({
        id: `${module.id}-${dependency.target}-${dependency.relation}`,
        source: module.id,
        target: dependency.target,
        relation: dependency.relation,
        guidanceNote: "Agent inferred module dependency"
      }))
  );

  return {
    projectMap: parsed.projectMap,
    moduleMap: parsed.moduleMap,
    apiMap: parsed.apiMap,
    source: "agent",
    agentOutput,
    graph: { nodes, edges }
  };
}

function createFallbackResult(
  project: CodeflowProject,
  nodes: GraphNode[],
  edges: GraphEdge[],
  source: AgentAnalysisResult["source"],
  agentOutput?: string
): AgentAnalysisResult {
  return {
    projectMap: {
      language: Object.entries(project.summary.languages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
      entryFiles: nodes.find((node) => node.nodeType === "entrypoint")?.files.slice(0, 3) ?? [],
      directories: project.files
        .filter((file) => file.type === "folder")
        .slice(0, 20)
        .map((file) => ({ path: file.path, purpose: "Scanned project directory" }))
    },
    moduleMap: {
      modules: nodes.map((node) => ({
        id: node.id,
        title: node.title,
        description: node.description,
        files: node.files,
        dependencies: edges.filter((edge) => edge.source === node.id).map((edge) => ({ target: edge.target, relation: edge.relation })),
        risk: node.risk
      }))
    },
    source,
    agentOutput,
    graph: { nodes, edges }
  };
}

function parseAnalysisJson(output: string) {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { projectMap?: ProjectMap; moduleMap?: ModuleMap; apiMap?: ApiMap };
    if (!parsed.projectMap || !parsed.moduleMap?.modules) return undefined;
    return parsed as { projectMap: ProjectMap; moduleMap: ModuleMap; apiMap?: ApiMap };
  } catch {
    return undefined;
  }
}

async function writeAnalysisArtifacts(projectPath: string, result: AgentAnalysisResult) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "project-map.json"), `${JSON.stringify(result.projectMap, null, 2)}\n`, "utf8"),
    writeFile(join(root, "module-map.json"), `${JSON.stringify(result.moduleMap, null, 2)}\n`, "utf8")
  ]);
}

function renderFileTree(files: CodeflowProject["files"]) {
  const lines: string[] = [];
  function visit(node: CodeflowProject["files"][number]) {
    lines.push(`${"  ".repeat(node.depth)}- ${node.path}${node.type === "folder" ? "/" : ""}`);
    node.children?.forEach(visit);
  }
  files.forEach(visit);
  return lines.slice(0, 1200).join("\n");
}

function mockAnalysisJson(project: CodeflowProject, nodes: GraphNode[], edges: GraphEdge[]) {
  const fallback = createFallbackResult(project, nodes, edges, "agent");
  return JSON.stringify(
    {
      projectMap: fallback.projectMap,
      moduleMap: fallback.moduleMap,
      apiMap: { endpoints: [] }
    },
    null,
    2
  );
}

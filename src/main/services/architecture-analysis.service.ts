import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchitectureAnalysisResult,
  ArchitectureMap,
  ArchitectureModule,
  ArchitectureModuleCategory,
  ArchitectureRelationship,
  CodeflowProject,
  FileInsight,
  GraphEdge,
  GraphEdgeRelation,
  GraphNode,
  GraphNodeType,
  GraphRisk,
  ModuleMap,
  ProjectMap,
  ProjectStructureFacts,
  RuntimeAgentId,
  StructureSymbol,
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { startToolPlan } from "./agent-run.service";
import { buildProjectStructureFacts } from "./structure-extractor.service";

const MAX_PROMPT_FILES = 260;
const MAX_PROMPT_SYMBOLS_PER_FILE = 18;

export async function analyzeArchitecture(project: CodeflowProject, toolId: RuntimeAgentId): Promise<ArchitectureAnalysisResult> {
  const facts = await buildProjectStructureFacts(project);
  const fallbackMap = createFallbackArchitectureMap(project, facts, "fallback");
  const prompt = buildArchitecturePrompt(facts);

  if (toolId === "mock") {
    const agentOutput = mockArchitectureJson(fallbackMap);
    const parsed = parseArchitectureJson(agentOutput, project, facts);
    const architectureMap = parsed ?? createFallbackArchitectureMap(project, facts, "fallback");
    await writeArchitectureArtifacts(project.rootPath, architectureMap);
    return architectureMapToResult(architectureMap, agentOutput);
  }

  try {
    const runResult = await startToolPlan({
      projectPath: project.rootPath,
      toolId,
      prompt,
      executionMode: "plan"
    });
    if (runResult.status !== "completed") {
      throw new Error(runResult.stderr ?? runResult.summary ?? "Agent architecture analysis failed");
    }
    const agentOutput = runResult.events
      .filter((event) => event.type === "stdout")
      .map((event) => event.content)
      .join("\n");
    const architectureMap = parseArchitectureJson(agentOutput, project, facts) ?? fallbackMap;
    await writeArchitectureArtifacts(project.rootPath, architectureMap);
    return architectureMapToResult(architectureMap, agentOutput);
  } catch (error) {
    await writeArchitectureArtifacts(project.rootPath, fallbackMap);
    return architectureMapToResult(fallbackMap, String(error));
  }
}

export async function readArchitectureMap(projectPath: string): Promise<ArchitectureMap | undefined> {
  const architecturePath = join(projectPath, FLOWWEAVE_DIR, "architecture-map.json");
  return readFile(architecturePath, "utf8")
    .then((content) => JSON.parse(content) as ArchitectureMap)
    .catch(() => undefined);
}

export function buildArchitecturePrompt(facts: ProjectStructureFacts) {
  return `You are FlowWeave's architecture analyst. Return only JSON.

Goal:
Create a functional architecture module map for a visual Canvas. Nodes must represent feature/architecture modules, not individual files or folders.

Project: ${facts.projectName}
Languages: ${JSON.stringify(facts.languages)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Return this exact JSON shape:
{
  "architectureStyle": "short architecture style, e.g. layered service, desktop app, MVC, event-driven",
  "modules": [{
    "id": "stable-kebab-id",
    "title": "Human module title",
    "category": "api-boundary|domain-service|data-access|external-integration|job-worker|shared-utility|test-surface",
    "role": "one sentence role",
    "description": "one concise paragraph",
    "files": ["path"],
    "fileRoles": [{"path": "path", "role": "why this file belongs here"}],
    "symbols": [{"name": "symbol", "kind": "function|class|method|export|variable", "filePath": "path", "role": "why it matters"}],
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "import/function/call evidence"}],
    "risk": "normal|review|blocked",
    "confidence": 0.0
  }],
  "relationships": [{
    "source": "module-id",
    "target": "module-id",
    "relation": "depends_on|calls|reads_writes|external_api|publishes_event|subscribes_event|tests",
    "description": "how these modules connect",
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "specific connection evidence"}]
  }]
}

Rules:
- Prefer 5-12 functional architecture modules for medium projects.
- Merge files by responsibility: API boundaries, domain services, data access, external integrations, workers, utilities, tests.
- Do not create one node per file.
- Every module must include concrete files and at least one evidence item when possible.
- Every relationship must explain how modules connect using imports, calls, symbols, or external call hints.
- Use only relation and category enum values shown above.`;
}

export function parseArchitectureJson(output: string, project: CodeflowProject, facts: ProjectStructureFacts): ArchitectureMap | undefined {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as Partial<ArchitectureMap>;
    if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) return undefined;
    const fileSet = new Set(facts.files.map((file) => file.path));
    const modules = parsed.modules.map((module, index) => normalizeModule(module, facts, fileSet, index)).filter((module): module is ArchitectureModule => Boolean(module));
    if (modules.length === 0) return undefined;
    const moduleIds = new Set(modules.map((module) => module.id));
    const relationships = (parsed.relationships ?? [])
      .map((relationship, index) => normalizeRelationship(relationship, moduleIds, index))
      .filter((relationship): relationship is ArchitectureRelationship => Boolean(relationship));

    return {
      version: 1,
      projectName: project.projectName,
      rootPath: project.rootPath,
      generatedAt: new Date().toISOString(),
      source: "agent",
      architectureStyle: stringOrUndefined(parsed.architectureStyle),
      modules,
      relationships,
      files: applyModuleIds(facts.files, modules),
      symbols: modules.flatMap((module) => module.symbols)
    };
  } catch {
    return undefined;
  }
}

export function architectureMapToResult(architectureMap: ArchitectureMap, agentOutput?: string): ArchitectureAnalysisResult {
  return {
    architectureMap,
    source: architectureMap.source,
    agentOutput,
    graph: architectureMapToGraph(architectureMap)
  };
}

export function architectureMapToGraph(architectureMap: ArchitectureMap): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = architectureMap.modules.map((module, index): GraphNode => ({
    id: module.id,
    title: module.title,
    subtitle: categoryLabel(module.category),
    kind: "module",
    nodeType: nodeTypeFromCategory(module.category),
    risk: module.risk,
    description: module.description,
    files: module.files,
    guidanceDraft: `请围绕 ${module.title} 的功能架构职责修改代码，优先参考右侧 Files、Functions 和 Connections 证据。`,
    status: architectureMap.source === "agent" ? "mapped" : "needs-review",
    x: xForCategory(module.category) + (index % 2) * 34,
    y: yForCategory(module.category, index),
    category: module.category,
    role: module.role,
    fileRoles: module.fileRoles,
    symbols: module.symbols,
    evidence: module.evidence,
    confidence: module.confidence
  }));
  const edges = architectureMap.relationships.map((relationship): GraphEdge => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    relation: relationship.relation,
    guidanceNote: relationship.description,
    evidence: relationship.evidence
  }));
  return { nodes, edges };
}

export function architectureMapToProjectMap(map: ArchitectureMap): ProjectMap {
  return {
    language: Object.entries(languageCounts(map.files)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
    framework: map.architectureStyle,
    entryFiles: map.modules.filter((module) => module.category === "api-boundary").flatMap((module) => module.files).slice(0, 8),
    directories: map.modules.map((module) => ({
      path: module.files[0] ?? module.id,
      purpose: module.role
    }))
  };
}

export function architectureMapToModuleMap(map: ArchitectureMap): ModuleMap {
  return {
    modules: map.modules.map((module) => ({
      id: module.id,
      title: module.title,
      description: module.description,
      files: module.files,
      dependencies: map.relationships
        .filter((relationship) => relationship.source === module.id)
        .map((relationship) => ({ target: relationship.target, relation: relationship.relation })),
      risk: module.risk
    }))
  };
}

async function writeArchitectureArtifacts(projectPath: string, architectureMap: ArchitectureMap) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "architecture-map.json"), `${JSON.stringify(architectureMap, null, 2)}\n`, "utf8"),
    writeFile(join(root, "file-insights.json"), `${JSON.stringify(architectureMap.files, null, 2)}\n`, "utf8"),
    writeFile(join(root, "module-map.json"), `${JSON.stringify(architectureMapToModuleMap(architectureMap), null, 2)}\n`, "utf8")
  ]);
}

function createFallbackArchitectureMap(project: CodeflowProject, facts: ProjectStructureFacts, source: ArchitectureMap["source"]): ArchitectureMap {
  const groups = new Map<string, FileInsight[]>();
  for (const file of facts.files) {
    const key = fallbackModuleId(file);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  const modules = [...groups.entries()].map(([id, files]): ArchitectureModule => {
    const category = fallbackCategory(files);
    const symbols = files.flatMap((file) => file.symbols.slice(0, 12));
    return {
      id,
      title: titleFromId(id),
      category,
      nodeType: nodeTypeFromCategory(category),
      role: fallbackRole(category),
      description: `${titleFromId(id)} groups ${files.length} files by detected architecture responsibility.`,
      files: files.map((file) => file.path),
      fileRoles: files.map((file) => ({ path: file.path, role: fileRoleFromInsight(file, category) })),
      symbols,
      evidence: files.slice(0, 5).map((file) => ({
        filePath: file.path,
        symbol: file.symbols[0]?.name,
        detail: evidenceFromInsight(file)
      })),
      risk: riskFromFiles(files),
      confidence: 0.55
    };
  });

  const relationships = inferFallbackRelationships(modules, facts.files);
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source,
    architectureStyle: "inferred functional architecture",
    modules,
    relationships,
    files: applyModuleIds(facts.files, modules),
    symbols: modules.flatMap((module) => module.symbols)
  };
}

function inferFallbackRelationships(modules: ArchitectureModule[], files: FileInsight[]) {
  const moduleByFile = new Map<string, string>();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  const relationships: ArchitectureRelationship[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const source = moduleByFile.get(file.path);
    if (!source) continue;
    for (const specifier of file.imports) {
      const targetFile = resolveImportBySuffix(specifier, moduleByFile);
      const target = targetFile ? moduleByFile.get(targetFile) : undefined;
      if (!target || target === source) continue;
      const relation = relationForModules(modules, source, target);
      const key = `${source}:${target}:${relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({
        id: `${source}-${target}-${relation}`,
        source,
        target,
        relation,
        description: `${file.path} imports ${specifier}`,
        evidence: [{ filePath: file.path, detail: `Import reference: ${specifier}` }]
      });
    }

    if (file.externalCalls.length > 0) {
      const external = modules.find((module) => module.category === "external-integration");
      if (external && external.id !== source) {
        const key = `${source}:${external.id}:external_api`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push({
            id: `${source}-${external.id}-external-api`,
            source,
            target: external.id,
            relation: "external_api",
            description: `${file.path} performs external calls`,
            evidence: file.externalCalls.slice(0, 3).map((call) => ({ filePath: file.path, symbol: call.symbol, detail: `${call.kind}: ${call.target}` }))
          });
        }
      }
    }
  }

  return relationships.slice(0, 180);
}

function normalizeModule(module: Partial<ArchitectureModule>, facts: ProjectStructureFacts, fileSet: Set<string>, index: number): ArchitectureModule | undefined {
  const id = safeId(module.id ?? module.title ?? `module-${index + 1}`);
  const files = (module.files ?? []).filter((file) => fileSet.has(file));
  if (!id || files.length === 0) return undefined;
  const category = isCategory(module.category) ? module.category : fallbackCategory(facts.files.filter((file) => files.includes(file.path)));
  const symbols = normalizeSymbols(module.symbols ?? [], files);
  return {
    id,
    title: module.title?.trim() || titleFromId(id),
    category,
    nodeType: nodeTypeFromCategory(category),
    role: module.role?.trim() || fallbackRole(category),
    description: module.description?.trim() || fallbackRole(category),
    files,
    fileRoles: normalizeFileRoles(module.fileRoles, files),
    symbols,
    evidence: normalizeEvidence(module.evidence, files),
    risk: isRisk(module.risk) ? module.risk : riskFromFiles(facts.files.filter((file) => files.includes(file.path))),
    confidence: typeof module.confidence === "number" ? module.confidence : undefined
  };
}

function normalizeRelationship(relationship: Partial<ArchitectureRelationship>, moduleIds: Set<string>, index: number): ArchitectureRelationship | undefined {
  if (!relationship.source || !relationship.target || !moduleIds.has(relationship.source) || !moduleIds.has(relationship.target)) return undefined;
  const relation = isRelation(relationship.relation) ? relationship.relation : "depends_on";
  return {
    id: relationship.id || `${relationship.source}-${relationship.target}-${relation}-${index}`,
    source: relationship.source,
    target: relationship.target,
    relation,
    description: relationship.description || `${relationship.source} ${relation} ${relationship.target}`,
    evidence: normalizeEvidence(relationship.evidence, [])
  };
}

function compactFactsForPrompt(facts: ProjectStructureFacts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 40),
      exports: file.exports.slice(0, 30),
      symbols: file.symbols.slice(0, MAX_PROMPT_SYMBOLS_PER_FILE).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported
      })),
      calls: file.calls.slice(0, 35),
      externalCalls: file.externalCalls.slice(0, 20)
    }))
  };
}

function mockArchitectureJson(map: ArchitectureMap) {
  return JSON.stringify(
    {
      architectureStyle: map.architectureStyle,
      modules: map.modules,
      relationships: map.relationships
    },
    null,
    2
  );
}

function applyModuleIds(files: FileInsight[], modules: ArchitectureModule[]) {
  const moduleByFile = new Map<string, string>();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  return files.map((file) => ({ ...file, moduleId: moduleByFile.get(file.path), role: file.role ?? fileRoleFromInsight(file, modules.find((module) => module.id === moduleByFile.get(file.path))?.category) }));
}

function fallbackModuleId(file: FileInsight) {
  const category = fallbackCategory([file]);
  const parts = file.path.split("/");
  const srcIndex = parts.lastIndexOf("src");
  const scope = srcIndex >= 0 ? parts[srcIndex + 1] : parts[0];
  if (category === "external-integration") return "external-integrations";
  if (category === "data-access") return "data-access";
  if (category === "api-boundary") return `${scope ?? "api"}-api`;
  if (category === "test-surface") return "test-surface";
  if (category === "job-worker") return `${scope ?? "worker"}-worker`;
  if (category === "shared-utility") return "shared-utilities";
  return safeId(scope ?? "domain-service");
}

function fallbackCategory(files: FileInsight[]): ArchitectureModuleCategory {
  const text = files.map((file) => `${file.path} ${file.imports.join(" ")} ${file.externalCalls.map((call) => call.kind).join(" ")}`).join("\n");
  if (/test|spec|__tests__/i.test(text)) return "test-surface";
  if (/controller|route|router|api|endpoint/i.test(text)) return "api-boundary";
  if (/repository|database|prisma|schema|migration|sql|mongoose|sequelize|knex|db\b/i.test(text)) return "data-access";
  if (/https?:|fetch|axios|requests|external|webhook|client/i.test(text)) return "external-integration";
  if (/worker|job|queue|cron|schedule|consumer/i.test(text)) return "job-worker";
  if (/util|helper|shared|common|constants|config/i.test(text)) return "shared-utility";
  return "domain-service";
}

function relationForModules(modules: ArchitectureModule[], source: string, target: string): GraphEdgeRelation {
  const targetModule = modules.find((module) => module.id === target);
  if (targetModule?.category === "data-access") return "reads_writes";
  if (targetModule?.category === "external-integration") return "external_api";
  if (targetModule?.category === "test-surface") return "tests";
  return "depends_on";
}

function resolveImportBySuffix(specifier: string, moduleByFile: Map<string, string>) {
  const normalized = specifier.replace(/^\.\.?\//, "").replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "");
  return [...moduleByFile.keys()].find((file) => file.includes(normalized) || file.replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "").endsWith(normalized));
}

function nodeTypeFromCategory(category: ArchitectureModuleCategory): GraphNodeType {
  const map: Record<ArchitectureModuleCategory, GraphNodeType> = {
    "api-boundary": "api",
    "domain-service": "service",
    "data-access": "data",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "test"
  };
  return map[category];
}

function categoryLabel(category: ArchitectureModuleCategory) {
  const labels: Record<ArchitectureModuleCategory, string> = {
    "api-boundary": "API Boundary",
    "domain-service": "Domain Service",
    "data-access": "Data Access",
    "external-integration": "External Integration",
    "job-worker": "Job / Worker",
    "shared-utility": "Shared Utility",
    "test-surface": "Test Surface"
  };
  return labels[category];
}

function xForCategory(category: ArchitectureModuleCategory) {
  if (category === "api-boundary") return 80;
  if (category === "domain-service") return 400;
  if (category === "data-access" || category === "external-integration") return 720;
  return 1040;
}

function yForCategory(category: ArchitectureModuleCategory, index: number) {
  const base = category === "test-surface" || category === "shared-utility" ? 470 : 110;
  return base + Math.floor(index / 2) * 170;
}

function fallbackRole(category: ArchitectureModuleCategory) {
  return `${categoryLabel(category)} module inferred from file structure and code symbols.`;
}

function fileRoleFromInsight(file: FileInsight, category?: ArchitectureModuleCategory) {
  if (file.symbols.length > 0) return `Defines ${file.symbols.slice(0, 4).map((symbol) => symbol.name).join(", ")} for ${category ? categoryLabel(category) : "this module"}.`;
  if (file.externalCalls.length > 0) return `Contains ${file.externalCalls[0].kind} integration hints.`;
  return "Contributes source code to this architecture module.";
}

function evidenceFromInsight(file: FileInsight) {
  if (file.imports.length > 0) return `Imports: ${file.imports.slice(0, 5).join(", ")}`;
  if (file.externalCalls.length > 0) return `External calls: ${file.externalCalls.map((call) => call.target).slice(0, 5).join(", ")}`;
  if (file.symbols.length > 0) return `Symbols: ${file.symbols.map((symbol) => symbol.name).slice(0, 5).join(", ")}`;
  return "File path and language contributed to module classification.";
}

function normalizeSymbols(symbols: StructureSymbol[], files: string[]) {
  return symbols.filter((symbol) => files.includes(symbol.filePath)).slice(0, 80);
}

function normalizeFileRoles(fileRoles: ArchitectureModule["fileRoles"] | undefined, files: string[]) {
  const roleByFile = new Map((fileRoles ?? []).map((item) => [item.path, item.role]));
  return files.map((path) => ({ path, role: roleByFile.get(path) || "Contributes to this architecture module." }));
}

function normalizeEvidence(evidence: ArchitectureModule["evidence"] | undefined, files: string[]) {
  return (evidence ?? [])
    .filter((item) => !item.filePath || files.length === 0 || files.includes(item.filePath))
    .map((item) => ({ filePath: item.filePath, symbol: item.symbol, detail: item.detail || "Architecture evidence" }))
    .slice(0, 30);
}

function riskFromFiles(files: FileInsight[]): GraphRisk {
  if (files.some((file) => /secret|token|credential|\.env|\.key|\.pem/i.test(file.path))) return "blocked";
  if (files.some((file) => /auth|security|payment|billing|permission/i.test(file.path))) return "review";
  return "normal";
}

function titleFromId(id: string) {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
}

function isCategory(value: unknown): value is ArchitectureModuleCategory {
  return (
    value === "api-boundary" ||
    value === "domain-service" ||
    value === "data-access" ||
    value === "external-integration" ||
    value === "job-worker" ||
    value === "shared-utility" ||
    value === "test-surface"
  );
}

function isRelation(value: unknown): value is GraphEdgeRelation {
  return value === "depends_on" || value === "calls" || value === "reads_writes" || value === "external_api" || value === "publishes_event" || value === "subscribes_event" || value === "tests";
}

function isRisk(value: unknown): value is GraphRisk {
  return value === "normal" || value === "review" || value === "blocked";
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function languageCounts(files: FileInsight[]) {
  return files.reduce<Record<string, number>>((counts, file) => {
    if (!file.language) return counts;
    counts[file.language] = (counts[file.language] ?? 0) + 1;
    return counts;
  }, {});
}

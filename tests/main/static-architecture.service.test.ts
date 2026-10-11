import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { architectureMapToGraph, buildStaticArchitecture, deriveArchitectureGroups } from "../../src/main/services/static-architecture.service";
import { generateProject } from "../../src/main/services/project-generation.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { createArchitectureInputFingerprint } from "../../src/main/services/architecture-review.service";
import { readProjectProtocolCanvas, readProjectProtocolOverview, readProjectProtocolSnapshot, saveProjectProtocolCanvas } from "../../src/main/storage/flowweave-store";
import { readArchitectureMap } from "../../src/main/services/architecture-analysis.service";
import type {
  AnalysisScope, ArchitectureGroup, ArchitectureModule, ArchitectureModuleCategory, FileInsight,
  CanvasUserStateV1, ProjectStructureFacts, SemanticRelation, SourceRange, StructureSymbol
} from "../../src/types";

describe("static-architecture.service", () => {
  it("keeps sparse modules without functional-path or call evidence in separate review areas", () => {
    const paths = ["src/api/routes.ts", "src/services/worker.ts", "src/storage/connection.ts"];
    const modules = [
      architectureModule("api", "Routes", [paths[0]], "api-boundary"),
      architectureModule("worker", "Worker", [paths[1]], "job-worker"),
      architectureModule("database", "Connection", [paths[2]], "data-access")
    ];
    const facts = structureFacts(paths, [analysisScope("application", "src", paths)], [], []);

    const groups = deriveArchitectureGroups(modules, facts);
    const areas = modules.map((module) => areaForModule(groups, module.id));

    expect(new Set(areas.map((group) => group.id)).size).toBe(modules.length);
    expect(areas.map((group) => group.title)).toEqual([
      "Needs Review · Routes", "Needs Review · Worker", "Needs Review · Connection"
    ]);
    expect(areas[0].titleSources).toEqual(expect.arrayContaining(["category:api-boundary", "module:api"]));
  });

  it("records the exported symbol used to derive a functional area title", () => {
    const path = "src/api/routes.ts";
    const module = architectureModule("customer", "Routes", [path], "api-boundary");
    const facts = structureFacts([path], [analysisScope("application", "src", [path])], [], [
      { name: "customer", kind: "function", filePath: path, exported: true }
    ]);

    const group = areaForModule(deriveArchitectureGroups([module], facts), module.id);

    expect(group.title).toBe("Customer");
    expect(group.titleSources).toContain(`symbol:${path}#customer`);
  });

  it("keeps same-named functional areas in separate package scopes", () => {
    const adminPath = "apps/admin/src/features/customer/api.ts";
    const publicPath = "apps/public/src/features/customer/api.ts";
    const modules = [
      architectureModule("admin-customer", "Customer API", [adminPath], "api-boundary"),
      architectureModule("public-customer", "Customer API", [publicPath], "api-boundary")
    ];
    const facts = structureFacts([adminPath, publicPath], [
      analysisScope("admin", "apps/admin", [adminPath]),
      analysisScope("public", "apps/public", [publicPath])
    ], [], []);

    const groups = deriveArchitectureGroups(modules, facts);
    const adminArea = areaForModule(groups, "admin-customer");
    const publicArea = areaForModule(groups, "public-customer");

    expect(adminArea.title).toBe("Customer");
    expect(publicArea.title).toBe("Customer");
    expect(adminArea.titleSources).toContain(`directory:${adminPath}`);
    expect(publicArea.titleSources).toContain(`directory:${publicPath}`);
    expect(adminArea.id).not.toBe(publicArea.id);
    expect(adminArea.parentId).not.toBe(publicArea.parentId);
  });

  it("keeps shared logging and database support apart from functional areas", () => {
    const customerPath = "src/features/customer/customer.service.ts";
    const billingPath = "src/features/billing/billing.service.ts";
    const loggerPath = "src/shared/logging/logger.ts";
    const databasePath = "src/shared/database/connection.ts";
    const modules = [
      architectureModule("customer", "Customer", [customerPath], "domain-service"),
      architectureModule("billing", "Billing", [billingPath], "domain-service"),
      architectureModule("logger", "Logger", [loggerPath], "shared-utility"),
      architectureModule("database", "Database", [databasePath], "shared-utility")
    ];
    const facts = structureFacts([customerPath, billingPath, loggerPath, databasePath], [
      analysisScope("application", "src", [customerPath, billingPath, loggerPath, databasePath])
    ], [
      factRelation("customer-logger", customerPath, loggerPath),
      factRelation("billing-logger", billingPath, loggerPath),
      factRelation("customer-database", customerPath, databasePath),
      factRelation("billing-database", billingPath, databasePath)
    ], []);

    const groups = deriveArchitectureGroups(modules, facts);
    const customerArea = areaForModule(groups, "customer");
    const billingArea = areaForModule(groups, "billing");
    const loggerArea = areaForModule(groups, "logger");
    const databaseArea = areaForModule(groups, "database");

    expect(customerArea.id).not.toBe(billingArea.id);
    expect(loggerArea.id).not.toBe(customerArea.id);
    expect(loggerArea.id).not.toBe(billingArea.id);
    expect(databaseArea.id).not.toBe(loggerArea.id);
    expect(loggerArea.title).toBe("Shared Infrastructure · Logger");
    expect(databaseArea.title).toBe("Shared Infrastructure · Database");
  });

  it("joins API, service, and storage modules when shared names and confirmed links support one responsibility", () => {
    const apiPath = "src/api/customer.ts";
    const servicePath = "src/services/customer.service.ts";
    const repositoryPath = "src/storage/customer.repository.ts";
    const modules = [
      architectureModule("customer-api", "Customer API", [apiPath], "api-boundary"),
      architectureModule("customer-service", "Customer Service", [servicePath], "domain-service"),
      architectureModule("customer-storage", "Customer Repository", [repositoryPath], "data-access")
    ];
    const facts = structureFacts([apiPath, servicePath, repositoryPath], [
      analysisScope("application", "src", [apiPath, servicePath, repositoryPath])
    ], [
      factRelation("api-service", apiPath, servicePath),
      factRelation("service-storage", servicePath, repositoryPath)
    ], [
      { name: "customerRoute", kind: "function", filePath: apiPath, exported: true },
      { name: "customerService", kind: "function", filePath: servicePath, exported: true },
      { name: "customerRepository", kind: "function", filePath: repositoryPath, exported: true }
    ]);

    const groups = deriveArchitectureGroups(modules, facts);
    const areas = modules.map((module) => areaForModule(groups, module.id));

    expect(new Set(areas.map((group) => group.id)).size).toBe(1);
    expect(areas[0].title).toBe("Customer");
  });

  it("preserves user module edits across a rescan without writing legacy mirrors", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-wording-upgrade-"));
    await writeSource(root, "frontend/src/shared/ui/utils.ts", "export const format = () => 1;\n");
    await writeSource(root, "frontend/src/types/api.ts", "export type Api = string;\n");
    await commitProjectGeneration(root);
    const canvas = await readProjectProtocolCanvas(root);
    if (!canvas) throw new Error("Expected protocol v7 Canvas.");
    const editedCanvas = {
      ...canvas,
      nodes: canvas.nodes.map((node) => node.files.includes("frontend/src/types/api.ts")
        ? { ...node, title: "My Contracts", guidanceDraft: "Keep the user instructions." } : node)
    };
    await saveProjectProtocolCanvas(root, editedCanvas);
    await writeSource(root, "frontend/src/types/api.ts", "export type Api = string; // updated\n");
    const second = await commitProjectGeneration(root);
    const upgraded = await readProjectProtocolCanvas(root);
    expect(upgraded?.nodes.find((node) => node.files.includes("frontend/src/shared/ui/utils.ts"))?.title).toBe("Shared Ui");
    expect(upgraded?.nodes.find((node) => node.files.includes("frontend/src/types/api.ts"))).toMatchObject({
      title: "My Contracts", guidanceDraft: "Keep the user instructions."
    });
    await expect(readFile(join(root, FLOWWEAVE_DIR, "project.json"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
    expect(second.written.canvasUserStatePath).toContain(join("canvas", "user-state.json"));
  });
  it("builds a local graph from the supplied semantic index without starting Agent review", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-architecture-"));
    await writeSource(root, "src/features/accounts/account.service.ts", `
      import { loadOrder } from "../orders/order.service";
      export function loadAccountOrders() { return loadOrder(); }
    `);
    await writeSource(root, "src/features/orders/order.service.ts", `
      export function loadOrder() { return { id: "order-1" }; }
    `);
    const project = await scanProject(await realpath(root));
    const builtIndex = await buildSemanticIndex(project);
    const index = {
      ...builtIndex.index,
      relations: [
        ...builtIndex.index.relations,
        unlocatedRelation("event-without-direction", "event", "src/features/accounts/account.service.ts"),
        unlocatedRelation("process-without-target", "process", "src/features/accounts/account.service.ts"),
        unlocatedRelation("http-without-endpoint", "http", "src/features/accounts/account.service.ts")
      ]
    };

    const result = await buildStaticArchitecture(project, index);

    expect(result.architectureMap.source).toBe("local");
    expect(result.scanFingerprint).toBe(project.scanFingerprint);
    expect(result.inputFingerprint).toBeTruthy();
    expect(result.graph.nodes.map((node) => node.id)).toEqual(result.architectureMap.modules.map((module) => module.id));
    expect(result.architectureMap.modules.map((module) => module.title)).toEqual(expect.arrayContaining(["Accounts", "Orders"]));
    expect(result.architectureMap.modules.every((module) => module.description.includes("source file") && !module.description.includes("business logic"))).toBe(true);
    expect(result.architectureMap.modules.every((module) => module.role.startsWith("Declares "))).toBe(true);
    const positions = result.graph.nodes.map(({ id, x, y }) => [id, x, y]);
    expect(new Set(positions.map(([, x, y]) => `${x}:${y}`)).size).toBe(positions.length);
    expect(architectureMapToGraph(result.architectureMap).nodes.map(({ id, x, y }) => [id, x, y])).toEqual(positions);
    expect(result.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "calls", confidence: "confirmed" })
    ]));
    expect(result.architectureMap.relationDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", reason: "direction-unknown", count: 1 }),
      expect.objectContaining({ kind: "process", reason: "direction-unknown", count: 1 }),
      expect.objectContaining({ kind: "http", reason: "unlocated-target", count: 1 })
    ]));
    await expect(readFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits the static graph in one snapshot and lightweight overview", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-persist-"));
    const accountPath = "src/features/accounts/account.service.ts";
    const orderPath = "src/features/orders/order.service.ts";
    const accountSource = 'import { loadOrder } from "../orders/order.service";\nexport function loadAccountOrders() { return loadOrder(); }\n';
    const orderSource = 'export function loadOrder() { return { id: "order-1" }; }\n';
    await writeSource(root, accountPath, accountSource);
    await writeSource(root, orderPath, orderSource);
    const project = await scanProject(await realpath(root));
    const { index } = await buildSemanticIndex(project);
    const staticArchitecture = await buildStaticArchitecture(project, index);

    const persisted = await commitProjectGeneration(root);
    const canvas = await readProjectProtocolCanvas(root);
    const snapshot = await readProjectProtocolSnapshot(root);
    const overview = await readProjectProtocolOverview(root);
    if (!canvas || !snapshot || !overview) throw new Error("Expected committed protocol v7 graph artifacts.");

    expect(canvas).not.toHaveProperty("version");
    expect(canvas.scanFingerprint).toBe(staticArchitecture.scanFingerprint);
    expect(canvas.nodes.map((node) => node.id)).toEqual(staticArchitecture.graph.nodes.map((node) => node.id));
    expect(canvas.edges.map((edge) => edge.id)).toEqual(staticArchitecture.graph.edges.map((edge) => edge.id));
    expect(snapshot.generationId).toBe(canvas.generation?.requestId);
    expect(snapshot.localArchitecture.metadata?.inputFingerprint).toBe(staticArchitecture.inputFingerprint);
    expect(overview.generationId).toBe(snapshot.generationId);
    expect(overview.nodes.map((node) => node.id)).toEqual(staticArchitecture.graph.nodes.map((node) => node.id));
    expect(overview.edges.map((edge) => edge.id)).toEqual(canvas.edges.map((edge) => edge.id));

    const semanticIndex = snapshot.semanticIndex;
    const scopes = semanticIndex.scopes ?? [];
    const relationIds = semanticIndex.relations.map((relation) => relation.id);
    const relationIdSet = new Set(relationIds);
    expect(relationIdSet.size).toBe(relationIds.length);
    expect(scopes.length).toBeGreaterThan(0);
    for (const symbol of semanticIndex.symbols) {
      if (!symbol.scopeId) continue;
      expect(scopes.find((scope) => scope.id === symbol.scopeId)?.paths).toContain(symbol.filePath);
      if (symbol.range) await expectSourceRange(root, symbol.filePath, symbol.range);
    }
    const declarationRelations = semanticIndex.relations.filter((relation) =>
      relation.targetRef?.kind === "file" && relation.targetRef.symbolId);
    expect(declarationRelations.length).toBeGreaterThan(0);
    for (const relation of semanticIndex.relations) {
      if (relation.scopeId) {
        expect(scopes.find((scope) => scope.id === relation.scopeId)?.paths).toContain(relation.sourceFile);
      }
      if (relation.sourceRange) await expectSourceRange(root, relation.sourceFile, relation.sourceRange);
      if (relation.targetRef?.kind !== "file" || !relation.targetRef.symbolId) continue;
      const declaration = semanticIndex.symbols.find((symbol) => symbol.id === relation.targetRef?.symbolId);
      expect(declaration).toMatchObject({ filePath: relation.targetRef.filePath, range: relation.targetRef.declarationRange });
      expect(scopes.find((scope) => scope.id === declaration?.scopeId)?.paths).toContain(relation.targetRef.filePath);
      if (relation.targetRef.declarationRange) {
        await expectSourceRange(root, relation.targetRef.filePath, relation.targetRef.declarationRange);
      }
    }
    for (const edge of overview.edges) {
      const sourceRelationIds = edge.sourceRelationIds ?? [];
      expect(new Set(sourceRelationIds).size).toBe(sourceRelationIds.length);
      for (const id of sourceRelationIds) expect(relationIdSet.has(id)).toBe(true);
    }

    const editedNode = canvas.nodes.find((node) => node.files.length > 0);
    if (!editedNode) throw new Error("Expected a generated node for the user-state integrity check.");
    await saveProjectProtocolCanvas(root, {
      ...canvas,
      nodes: canvas.nodes.map((node) => node.id === editedNode.id ? { ...node, title: `${node.title} edited` } : node)
    });
    const userState = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "canvas/user-state.json"), "utf8")) as CanvasUserStateV1;
    const overviewNodeIds = new Set(overview.nodes.map((node) => node.id));
    const overviewEdgeIds = new Set(overview.edges.map((edge) => edge.id));
    expect(Object.keys(userState.nodeEdits)).toContain(editedNode.id);
    expect(Object.keys(userState.nodeEdits).every((id) => overviewNodeIds.has(id))).toBe(true);
    expect(Object.keys(userState.edgeEdits).every((id) => overviewEdgeIds.has(id))).toBe(true);
    expect(userState.generationId).toBe(snapshot.generationId);
    await expect(readFile(join(root, FLOWWEAVE_DIR, "tasks/current.task.json"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(root, FLOWWEAVE_DIR, "context/file-tree.md"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("keeps a same-fingerprint review as a separate artifact without changing the static graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-review-lock-"));
    await writeSource(root, "src/features/accounts/account.service.ts", "export function account() { return true; }\n");
    const project = await scanProject(await realpath(root));
    const { index } = await buildSemanticIndex(project);
    const initial = await buildStaticArchitecture(project, index);
    await commitProjectGeneration(root);
    const initialSnapshot = await readProjectProtocolSnapshot(root);
    const reviewed = {
      ...initial.architectureMap,
      generation: initialSnapshot?.localArchitecture.generation,
      source: "agent" as const,
      modules: initial.architectureMap.modules.map((module) => ({ ...module, title: `Reviewed ${module.title}` })),
      metadata: {
        ...initial.architectureMap.metadata!,
        source: "agent" as const,
        agentId: "mock" as const,
        runId: "review-run",
        reviewId: "review-id"
      }
    };
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), JSON.stringify(reviewed), "utf8");

    const refreshed = await buildStaticArchitecture(project, index);
    const persisted = await commitProjectGeneration(root);
    const map = await readArchitectureMap(root);
    const snapshot = await readProjectProtocolSnapshot(root);

    expect(persisted.architectureMap.source).toBe("local");
    expect(map?.modules[0].title).toBe(reviewed.modules[0].title);
    expect(snapshot?.localArchitecture.source).toBe("local");
    expect(snapshot).not.toHaveProperty("architecture");
    expect(snapshot?.localArchitecture.modules[0].title).toBe(initial.architectureMap.modules[0].title);
  });

  it("invalidates a reviewed map from the previous clustering configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-clustering-version-"));
    await writeSource(root, "src/features/accounts/account.service.ts", "export function account() { return true; }\n");
    const project = await scanProject(await realpath(root));
    const { index } = await buildSemanticIndex(project);
    const current = await buildStaticArchitecture(project, index);
    const oldFingerprint = createArchitectureInputFingerprint({
      scanFingerprint: current.scanFingerprint,
      semanticIndexSchemaVersion: index.version,
      semanticIndexGeneratorVersion: index.generatorVersion,
      moduleClusteringConfigVersion: "2",
      architectureGeneratorVersion: "2",
      reviewContractVersion: "2"
    });
    expect(current.inputFingerprint).not.toBe(oldFingerprint);
    await commitProjectGeneration(root);
    const currentSnapshot = await readProjectProtocolSnapshot(root);
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), JSON.stringify({
      ...current.architectureMap,
      generation: currentSnapshot?.localArchitecture.generation,
      source: "agent",
      metadata: {
        ...current.architectureMap.metadata,
        source: "agent",
        inputFingerprint: oldFingerprint,
        agentId: "mock",
        runId: "old-run",
        reviewId: "old-review"
      }
    }), "utf8");

    const persisted = await commitProjectGeneration(root);
    expect(persisted.architectureMap.source).toBe("local");
    expect(persisted.architectureMap.metadata?.inputFingerprint).toBe(current.inputFingerprint);
    expect((await readArchitectureMap(root))?.source).toBe("local");
  });
});

async function writeSource(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function commitProjectGeneration(projectPath: string) {
  const result = await generateProject(projectPath, {});
  if (result.status === "superseded") throw new Error(`Project generation was superseded: ${result.requestId}`);
  return result;
}

async function expectSourceRange(projectPath: string, sourcePath: string, range: SourceRange): Promise<void> {
  const lines = (await readFile(join(projectPath, sourcePath), "utf8")).split(/\r?\n/);
  const startLine = lines[range.start.line - 1];
  const endLine = lines[range.end.line - 1];
  expect(startLine).toBeDefined();
  expect(endLine).toBeDefined();
  expect(range.start.column).toBeGreaterThan(0);
  expect(range.end.column).toBeGreaterThan(0);
  expect(range.end.line).toBeGreaterThanOrEqual(range.start.line);
  expect(range.start.column).toBeLessThanOrEqual((startLine?.length ?? 0) + 1);
  expect(range.end.column).toBeLessThanOrEqual((endLine?.length ?? 0) + 1);
  if (range.start.line === range.end.line) expect(range.end.column).toBeGreaterThanOrEqual(range.start.column);
}

function unlocatedRelation(
  id: string,
  kind: import("../../src/types").SemanticRelation["kind"],
  sourceFile: string
): import("../../src/types").SemanticRelation {
  return {
    id,
    kind,
    source: sourceFile,
    target: `${kind}-target`,
    sourceFile,
    detail: `${kind} target could not be located`,
    confidence: "inferred"
  };
}

function architectureModule(
  id: string,
  title: string,
  files: string[],
  category: ArchitectureModuleCategory
): ArchitectureModule {
  const nodeTypeByCategory: Record<ArchitectureModuleCategory, ArchitectureModule["nodeType"]> = {
    "api-boundary": "api",
    "domain-service": "service",
    "data-access": "data",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "test",
    "unknown": "module"
  };
  return {
    id,
    title,
    category,
    nodeType: nodeTypeByCategory[category],
    role: "Fixture role.",
    description: "Fixture module.",
    files,
    fileRoles: [],
    symbols: [],
    evidence: [],
    risk: "unknown"
  };
}

function analysisScope(id: string, rootPath: string, paths: string[]): AnalysisScope {
  return { id, language: "typescript", rootPath, sourceRoots: [rootPath], paths, configurationPaths: [] };
}

function structureFacts(
  paths: string[],
  scopes: AnalysisScope[],
  relations: SemanticRelation[],
  symbols: StructureSymbol[]
): ProjectStructureFacts {
  const files: FileInsight[] = paths.map((path) => ({
    path,
    language: "typescript",
    imports: [],
    exports: [],
    symbols: symbols.filter((symbol) => symbol.filePath === path),
    calls: [],
    externalCalls: []
  }));
  return { projectName: "Fixture", rootPath: "/fixture", languages: { typescript: paths.length }, files, scopes, relations };
}

function factRelation(id: string, sourceFile: string, targetFile: string): SemanticRelation {
  return {
    id,
    kind: "call",
    source: sourceFile,
    target: targetFile,
    sourceFile,
    targetFile,
    detail: `${sourceFile} calls ${targetFile}`,
    confidence: "confirmed"
  };
}

function areaForModule(groups: ArchitectureGroup[], moduleId: string): ArchitectureGroup {
  const group = groups.find((candidate) => candidate.parentId && candidate.moduleIds.includes(moduleId));
  if (!group) throw new Error(`Expected a non-package area for module ${moduleId}.`);
  return group;
}

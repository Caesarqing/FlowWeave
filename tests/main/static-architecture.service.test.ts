import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { architectureMapToGraph, buildStaticArchitecture } from "../../src/main/services/static-architecture.service";
import { persistStaticArchitecture } from "../../src/main/services/static-architecture.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { createArchitectureInputFingerprint } from "../../src/main/services/architecture-review.service";
import type { CodeflowCanvas } from "../../src/types";

describe("static-architecture.service", () => {
  it("refreshes old generated wording on rescan while preserving actual user overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-wording-upgrade-"));
    await writeSource(root, "frontend/src/shared/ui/utils.ts", "export const format = () => 1;\n");
    await writeSource(root, "frontend/src/types/api.ts", "export type Api = string;\n");
    const project = await scanProject(await realpath(root));
    const { index } = await buildSemanticIndex(project);
    const built = await buildStaticArchitecture(project, index);
    const first = await persistStaticArchitecture(project, built);
    const oldMap = {
      ...built.architectureMap,
      modules: built.architectureMap.modules.map((module) => module.title === "Shared Ui"
        ? { ...module, title: "Unknown", description: "Old generated description." } : module)
    };
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), JSON.stringify(oldMap), "utf8");
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), JSON.stringify(oldMap), "utf8");
    const canvas = JSON.parse(await readFile(first.written.canvasJsonPath, "utf8")) as CodeflowCanvas;
    const oldGraph = architectureMapToGraph(oldMap);
    await writeFile(first.written.canvasJsonPath, JSON.stringify({ ...canvas,
      nodes: oldGraph.nodes.map((node) => node.title === "Shared Contracts"
        ? { ...node, title: "My Contracts", guidanceDraft: "Keep the user instructions." } : node)
    }), "utf8");
    const second = await persistStaticArchitecture(project, built);
    const upgraded = JSON.parse(await readFile(second.written.canvasJsonPath, "utf8")) as CodeflowCanvas;
    expect(upgraded.nodes.find((node) => node.files.includes("frontend/src/shared/ui/utils.ts"))?.title).toBe("Shared Ui");
    expect(upgraded.nodes.find((node) => node.files.includes("frontend/src/types/api.ts"))).toMatchObject({
      title: "My Contracts", guidanceDraft: "Keep the user instructions."
    });
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

  it("writes the same static graph to Canvas, Task, and architecture artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-persist-"));
    await writeSource(root, "src/features/accounts/account.service.ts", `
      import { loadOrder } from "../orders/order.service";
      export function loadAccountOrders() { return loadOrder(); }
    `);
    await writeSource(root, "src/features/orders/order.service.ts", `
      export function loadOrder() { return { id: "order-1" }; }
    `);
    const project = await scanProject(await realpath(root));
    const { index } = await buildSemanticIndex(project);
    const staticArchitecture = await buildStaticArchitecture(project, index);

    const persisted = await persistStaticArchitecture(project, staticArchitecture);
    const canvas = JSON.parse(await readFile(persisted.written.canvasJsonPath, "utf8")) as {
      version: number;
      scanFingerprint: string;
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
    };
    const map = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), "utf8")) as {
      metadata: { inputFingerprint: string };
      relationships: Array<{ id: string }>;
    };
    const task = JSON.parse(await readFile(persisted.written.taskJsonPath, "utf8")) as {
      inputFingerprint: string;
      relations: Array<{ source: string; target: string; relation: string }>;
    };

    expect(canvas.version).toBe(6);
    expect(canvas.scanFingerprint).toBe(staticArchitecture.scanFingerprint);
    expect(canvas.nodes.map((node) => node.id)).toEqual(staticArchitecture.graph.nodes.map((node) => node.id));
    expect(canvas.edges.map((edge) => edge.id)).toEqual(staticArchitecture.graph.edges.map((edge) => edge.id));
    expect(map.metadata.inputFingerprint).toBe(staticArchitecture.inputFingerprint);
    expect(task.inputFingerprint).toBe(staticArchitecture.scanFingerprint);
    expect(task.relations).toHaveLength(staticArchitecture.graph.edges.length);
  });

  it("keeps a same-fingerprint reviewed map while refreshing the local baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-static-review-lock-"));
    await writeSource(root, "src/features/accounts/account.service.ts", "export function account() { return true; }\n");
    const project = await scanProject(await realpath(root));
    const { index } = await buildSemanticIndex(project);
    const initial = await buildStaticArchitecture(project, index);
    await persistStaticArchitecture(project, initial);
    const reviewed = {
      ...initial.architectureMap,
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
    const persisted = await persistStaticArchitecture(project, refreshed);
    const map = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), "utf8"));
    const local = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), "utf8"));

    expect(persisted.architectureMap.source).toBe("agent");
    expect(map.modules[0].title).toBe(reviewed.modules[0].title);
    expect(local.source).toBe("local");
    expect(local.modules[0].title).toBe(initial.architectureMap.modules[0].title);
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
    await persistStaticArchitecture(project, current);
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-map.json"), JSON.stringify({
      ...current.architectureMap,
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

    const persisted = await persistStaticArchitecture(project, current);
    expect(persisted.architectureMap.source).toBe("local");
    expect(persisted.architectureMap.metadata?.inputFingerprint).toBe(current.inputFingerprint);
  });
});

async function writeSource(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
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

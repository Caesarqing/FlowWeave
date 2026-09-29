import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../src/common/ipc-channels";
import { projectGraphForView } from "../../src/utils/graph-view-projection";

const registeredHandlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: {}
}));

import { dialog } from "electron";
import { registerProjectIpc } from "../../src/main/ipc/project.ipc";
import { configureProjectRegistry } from "../../src/main/services/project-registry.service";
import { writeArchitectureReviewStatus } from "../../src/main/services/architecture-review.service";
import type { ArchitectureMap, FlowWeaveProjectOpenResult } from "../../src/types";

afterEach(() => {
  registeredHandlers.clear();
  vi.clearAllMocks();
});

describe("first project open static graph", () => {
  it("reads a preserved v5 graph before a failed rescan without changing its bytes", async () => {
    const root = await projectRoot("legacy-readonly");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const first = await openProject(root);
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    const legacy = JSON.stringify({ ...canvas, version: 5 });
    await writeFile(canvasPath, legacy);
    const baselinePath = join(root, ".flowweave", "modification-baseline.json");
    const baseline = await readFile(baselinePath, "utf8");
    await writeSource(root, "tsconfig.json", '{ "extends":');
    const read = registeredHandlers.get(PROJECT_CHANNELS.readCanvas);
    if (!read) throw new Error("Canvas read IPC handler was not registered.");
    const result = await read({}, first.projectId) as { mode: string; canvas: { version: number; nodes: unknown[] } };
    expect(result.mode).toBe("legacy-readonly");
    expect(result.canvas.version).toBe(5);
    expect(result.canvas.nodes).toEqual(canvas.nodes);
    const save = registeredHandlers.get(PROJECT_CHANNELS.saveCanvas);
    if (!save) throw new Error("Canvas save IPC handler was not registered.");
    await expect(save({}, first.projectId, { ...canvas, version: 6 }, {})).rejects.toThrow(/read-only/);
    const readStored = registeredHandlers.get(PROJECT_CHANNELS.readRegisteredProject);
    if (!readStored) throw new Error("Stored project IPC handler was not registered.");
    expect(await readStored({}, first.projectId)).toMatchObject({
      projectId: first.projectId,
      canvas: { mode: "legacy-readonly", canvas: { version: 5 } }
    });
    await expect(rescanProject(first.projectId)).rejects.toThrow(/tsconfig.json/);
    expect(await readFile(canvasPath, "utf8")).toBe(legacy);
    expect(await readFile(baselinePath, "utf8")).toBe(baseline);
  });

  it("rejects malformed stored Canvas nodes with a path-specific error and preserves the file", async () => {
    const root = await projectRoot("malformed-canvas");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const project = await openProject(root);
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    canvas.nodes[0] = null;
    const malformed = JSON.stringify(canvas);
    await writeFile(canvasPath, malformed);
    const read = registeredHandlers.get(PROJECT_CHANNELS.readCanvas);
    if (!read) throw new Error("Canvas read IPC handler was not registered.");

    await expect(read({}, project.projectId)).rejects.toThrow(`${canvasPath}: nodes[0] must be an object`);
    expect(await readFile(canvasPath, "utf8")).toBe(malformed);
  });

  it("shows functional modules and evidenced runtime edges without Agent review", async () => {
    const root = await projectRoot("runtime");
    await writeSource(root, "src/features/accounts/account.service.ts", `
      import { loadOrder } from "../orders/order.service";
      export function loadAccountOrders() { return loadOrder(); }
    `);
    await writeSource(root, "src/features/orders/order.service.ts", `
      export function loadOrder() { return { id: "order-1" }; }
    `);
    const result = await openProject(root);
    const graph = result.graph;
    const execution = projectGraphForView(graph.nodes, graph.edges, "execution", {
      includeInferredDependencyOverlay: false
    });
    const canvas = JSON.parse(await readFile(join(root, ".flowweave", "canvas", "main.canvas.json"), "utf8"));

    expect(result.architectureReview.state).toBe("local");
    expect(result.architectureReview.reviewId).toBeUndefined();
    expect(graph.nodes.map((node) => node.title)).toEqual(expect.arrayContaining(["Accounts", "Orders"]));
    expect(graph.nodes.map((node) => node.title)).not.toContain("features");
    expect(graph.edges).toContainEqual(expect.objectContaining({ relation: "calls", confidence: "confirmed" }));
    expect(execution.edges.length).toBeGreaterThan(0);
    expect(canvas.version).toBe(6);
    expect(canvas.layout.viewMode).toBe("architecture");
  });

  it("opens dependency-only projects in the architecture overview", async () => {
    const root = await projectRoot("dependency-only");
    await writeSource(root, "src/features/accounts/account.service.ts", 'import "../orders/order.service";\nexport const account = true;\n');
    await writeSource(root, "src/features/orders/order.service.ts", "export const order = true;\n");
    const result = await openProject(root);
    const canvas = JSON.parse(await readFile(join(root, ".flowweave", "canvas", "main.canvas.json"), "utf8"));

    expect(result.graph.edges.map((edge) => edge.relation)).toContain("depends_on");
    expect(canvas.layout.viewMode).toBe("architecture");
    expect(projectGraphForView(result.graph.nodes, result.graph.edges, canvas.layout.viewMode, {
      includeInferredDependencyOverlay: false
    }).edges.length).toBeGreaterThan(0);
  });

  it("keeps unrelated modules unconnected and exposes skipped same-module evidence", async () => {
    const root = await projectRoot("no-cross-module-edges");
    await writeSource(root, "src/features/accounts/account.service.ts", `
      import { loadAccount } from "./account.repository";
      export function showAccount() { return loadAccount(); }
    `);
    await writeSource(root, "src/features/accounts/account.repository.ts", "export function loadAccount() { return 1; }\n");
    await writeSource(root, "src/features/orders/order.service.ts", "export function loadOrder() { return 2; }\n");
    const result = await openProject(root);
    const canvas = JSON.parse(await readFile(join(root, ".flowweave", "canvas", "main.canvas.json"), "utf8"));

    expect(result.graph.nodes).toHaveLength(2);
    expect(result.graph.edges).toEqual([]);
    expect(canvas.layout.viewMode).toBe("architecture");
    expect(result.relationDiagnostics).toContainEqual(expect.objectContaining({ reason: "same-module" }));
  });

  it("preserves the selected reviewed graph and manual Canvas content on rescan", async () => {
    const root = await projectRoot("reviewed-rescan");
    await writeSource(root, "src/features/accounts/account.service.ts", 'import { loadOrder } from "../orders/order.service";\nexport function loadAccount() { return loadOrder(); }\n');
    await writeSource(root, "src/features/orders/order.service.ts", "export function loadOrder() { return 1; }\n");
    const first = await openProject(root);
    const architecturePath = join(root, ".flowweave", "architecture-map.json");
    const architecture = JSON.parse(await readFile(architecturePath, "utf8")) as ArchitectureMap;
    const reviewed: ArchitectureMap = {
      ...architecture,
      source: "agent",
      architectureStyle: "reviewed architecture",
      metadata: {
        ...architecture.metadata!,
        source: "agent",
        agentId: "mock",
        runId: "run-reviewed",
        reviewId: "review-reviewed"
      }
    };
    await writeFile(architecturePath, JSON.stringify(reviewed), "utf8");
    await writeArchitectureReviewStatus(root, {
      state: "reviewed",
      projectId: first.projectId,
      artifactTarget: "architecture-map",
      scanFingerprint: first.scanFingerprint,
      inputFingerprint: architecture.metadata?.inputFingerprint,
      agentId: "mock",
      runId: "run-reviewed",
      reviewId: "review-reviewed"
    });
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    const manualNode = { ...canvas.nodes[0], id: "manual-note", title: "My note", files: [], origin: "manual" };
    canvas.version = 5;
    canvas.nodes.push(manualNode);
    canvas.edges.push({ id: "manual-link", source: "manual-note", target: canvas.nodes[0].id, relation: "depends_on", origin: "manual" });
    await writeFile(canvasPath, JSON.stringify(canvas), "utf8");

    const second = await rescanProject(first.projectId);
    const rescannedCanvas = JSON.parse(await readFile(canvasPath, "utf8"));
    expect(second.architectureReview.state).toBe("reviewed");
    expect(second.graph.nodes.map((node) => node.id)).toEqual(first.graph.nodes.map((node) => node.id));
    expect(second.graph.nodes.every((node) => node.status === "mapped")).toBe(true);
    expect(JSON.parse(await readFile(architecturePath, "utf8")).architectureStyle).toBe("reviewed architecture");
    expect(rescannedCanvas.version).toBe(6);
    expect(rescannedCanvas.nodes).toContainEqual(expect.objectContaining({ id: "manual-note", title: "My note" }));
    expect(rescannedCanvas.edges).toContainEqual(expect.objectContaining({ id: "manual-link" }));
  });
});

async function openProject(root: string): Promise<Exclude<FlowWeaveProjectOpenResult, { canceled: true }>> {
  const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
  await configureProjectRegistry(userData);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
  registerProjectIpc();
  const handler = registeredHandlers.get(PROJECT_CHANNELS.openProject);
  if (!handler) throw new Error("Project open IPC handler was not registered.");
  const sender = { isDestroyed: () => false, send: () => undefined };
  return await handler({ sender }, { concurrency: 2 }) as Exclude<FlowWeaveProjectOpenResult, { canceled: true }>;
}

async function rescanProject(projectId: string): Promise<Exclude<FlowWeaveProjectOpenResult, { canceled: true }>> {
  const handler = registeredHandlers.get(PROJECT_CHANNELS.scanProject);
  if (!handler) throw new Error("Project scan IPC handler was not registered.");
  const sender = { isDestroyed: () => false, send: () => undefined };
  return await handler({ sender }, projectId, { concurrency: 2 }) as Exclude<FlowWeaveProjectOpenResult, { canceled: true }>;
}

async function projectRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `flowweave-first-open-${prefix}-`));
}

async function writeSource(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

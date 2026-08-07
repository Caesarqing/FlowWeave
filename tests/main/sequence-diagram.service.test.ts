import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureAgentRegistry, saveCustomAgent } from "../../src/main/services/agent-registry.service";
import {
  buildSequenceDiagramRevisionPrompt,
  buildSequenceDiagramPrompt,
  generateSequenceDiagrams,
  parseSequenceDiagramBundleJson,
  readSequenceDiagrams,
  reviseSequenceDiagram
} from "../../src/main/services/sequence-diagram.service";
import { registerProject } from "../../src/main/services/project-registry.service";
import { buildProjectStructureFacts } from "../../src/main/services/structure-extractor.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import type { CodeflowProject, SequenceDiagramBundle } from "../../src/types";

describe("sequence-diagram.service", () => {
  it("builds a prompt for architectural diagrams only", async () => {
    const root = await createFixtureFiles();
    const facts = await buildProjectStructureFacts(projectFixture(root));
    const prompt = buildSequenceDiagramPrompt(facts);

    expect(prompt).toContain("Architectural Sequence Diagram");
    expect(prompt).toContain("Detailed Architectural Sequence Diagram");
    expect(prompt).not.toContain("Detailed Design Sequence Diagram");
    expect(prompt).not.toContain('"detailedDesign"');
    expect(prompt).toContain("ProjectStructureFacts");
    expect(prompt).toContain("src/api/order.controller.ts");
    expect(prompt).toContain("end-to-end workflow");
    expect(prompt).not.toContain("code-level call sequence");
    expect(prompt).toContain("entry/user action");
    expect(prompt).toContain("IPC/API boundary");
    expect(prompt).toContain("Do not return detailedDesign");
    expect(prompt).toContain("Prefer 6-14 participants and 8-24 messages");
    expect(prompt).toContain("methodName");
    expect(prompt).toContain("input");
    expect(prompt).toContain("output");
    expect(prompt).toContain("valid participant ids");
    expect(prompt).toContain("Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems");
  });

  it("builds a revision prompt that preserves evidence and returns a complete diagram", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);
    const current = diagramJson([
      {
        id: "controller-service",
        sequence: 1,
        from: "order-controller",
        to: "order-service",
        kind: "sync",
        label: "createOrder",
        methodName: "createOrder",
        input: "CreateOrderDto",
        output: "Order",
        evidence: [{ filePath: "src/api/order.controller.ts", symbol: "OrderController", detail: "calls OrderService.createOrder" }]
      }
    ]);
    const prompt = buildSequenceDiagramRevisionPrompt(current, "include validation before creating the order", facts);

    expect(prompt).toContain("Preserve reliable existing evidence");
    expect(prompt).toContain("Return the complete updated diagram object");
    expect(prompt).toContain('Keep kind exactly "architectural"');
    expect(prompt).toContain("Update participants and messages together");
    expect(prompt).toContain("methodName");
    expect(prompt).toContain("input");
    expect(prompt).toContain("output");
  });

  it("parses sequence diagram JSON and filters invalid messages", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);
    const bundle = parseSequenceDiagramBundleJson(
      JSON.stringify({
        architectural: diagramJson([
          { id: "request-payment", sequence: 1, from: "frontend-app", to: "api-gateway", kind: "sync", label: "POST /orders" },
          { id: "invalid", sequence: 2, from: "frontend-app", to: "missing", kind: "sync", label: "Invalid" }
        ])
      }),
      project,
      facts
    );

    expect(bundle?.architectural.messages).toHaveLength(1);
    expect(bundle?.architectural.messages[0]).toMatchObject({ id: "request-payment", from: "frontend-app", to: "api-gateway" });
  });

  it("maps raw participant ids and titles to normalized message endpoints", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);
    const bundle = parseSequenceDiagramBundleJson(
      JSON.stringify({
        architectural: {
          id: "architectural-sequence",
          title: "Architectural Sequence Diagram",
          kind: "architectural",
          summary: "Fixture diagram.",
          participants: [
            { id: "Frontend App", title: "Frontend App", kind: "actor", description: "Starts the flow." },
            { id: "API Gateway", title: "API Gateway", kind: "gateway", description: "Receives requests." }
          ],
          messages: [
            { id: "raw-id-message", sequence: 1, from: "Frontend App", to: "API Gateway", kind: "sync", label: "POST /orders" },
            { id: "normalized-id-message", sequence: 2, from: "frontend-app", to: "api-gateway", kind: "return", label: "Order result" }
          ],
          evidence: []
        }
      }),
      project,
      facts
    );

    expect(bundle?.architectural.participants.map((participant) => participant.id)).toEqual(["frontend-app", "api-gateway"]);
    expect(bundle?.architectural.messages).toEqual([
      expect.objectContaining({ id: "raw-id-message", from: "frontend-app", to: "api-gateway" }),
      expect.objectContaining({ id: "normalized-id-message", from: "frontend-app", to: "api-gateway" })
    ]);
  });

  it("returns a fresh local bundle without overwriting a trusted Agent bundle before review succeeds", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-sequence-agent-"));
    const root = await createFixtureFiles();
    const flowweaveRoot = join(root, FLOWWEAVE_DIR);
    await mkdir(flowweaveRoot, { recursive: true });
    const existing = existingBundle(root);
    await writeFile(join(flowweaveRoot, "sequence-diagrams.json"), `${JSON.stringify(existing, null, 2)}\n`, "utf8");

    const scriptPath = join(configRoot, "bad-sequence-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ architectural: { kind: 'architectural', participants: [], messages: [] } }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Bad Sequence Agent",
      command: process.execPath,
      args: [scriptPath]
    });

    const result = await generateSequenceDiagrams(projectFixture(root), agent.id);
    const stored = JSON.parse(await readFile(join(flowweaveRoot, "sequence-diagrams.json"), "utf8")) as SequenceDiagramBundle;

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error("Expected generated sequence result.");
    expect(result.bundle.source).toBe("local");
    expect(result.bundle.architectural.title).not.toBe("Existing Architectural");
    expect(stored.generatedAt).toBe(existing.generatedAt);
    expect(stored.architectural.title).toBe("Existing Architectural");
  });

  it("writes local semantic diagrams when agent output is invalid and no bundle exists", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-sequence-local-agent-"));
    const root = await createFixtureFiles();
    const scriptPath = join(configRoot, "bad-sequence-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ architectural: { kind: 'architectural', participants: [], messages: [] } }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Local Sequence Agent",
      command: process.execPath,
      args: [scriptPath]
    });

    const result = await generateSequenceDiagrams(projectFixture(root), agent.id);
    const stored = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"), "utf8")) as SequenceDiagramBundle;

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error("Expected local sequence generation.");
    expect(result.bundle.source).toBe("local");
    expect(result.bundle.metadata).toMatchObject({
      source: "local",
      inputFingerprint: expect.any(String)
    });
    expect(stored.metadata).toMatchObject({
      source: "local",
      inputFingerprint: result.bundle.metadata?.inputFingerprint
    });
    expect(result.warning).toBeUndefined();
    await expect(readFile(join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"), "utf8")).resolves.toContain('"source": "local"');
  });

  it("publishes a review-failed event after the Agent repair attempt is rejected", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-failed-"));
    const root = await createFixtureFiles();
    const scriptPath = join(configRoot, "bad-sequence-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ architectural: { kind: 'architectural', participants: [], messages: [] } }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Rejected Sequence Review Agent",
      command: process.execPath,
      args: [scriptPath]
    });
    const events: import("../../src/types").SequenceReviewEvent[] = [];

    const result = await generateSequenceDiagrams(projectFixture(root), agent.id, {
      projectId: "project-00000000-0000-0000-0000-000000000000",
      onSequenceReview: (event) => events.push(event)
    });

    expect(result.outcome).toBe("generated");
    await waitFor(() => events.some((event) => event.status.state === "review-failed"));
    expect(events.map((event) => event.status.state)).toContain("reviewing");
    expect(events.at(-1)?.status).toMatchObject({
      state: "review-failed",
      error: { message: expect.any(String) }
    });
  });

  it("waits for Agent Inbox response.json before completing sequence review", async () => {
    const root = await createFixtureFiles();
    const projectId = await registerProject(root);
    const events: import("../../src/types").SequenceReviewEvent[] = [];

    void writeDesktopSequenceResponseWhenRunStarts(root, projectId, events);

    const result = await generateSequenceDiagrams(projectFixture(root), "codex-desktop", {
      projectId,
      onSequenceReview: (event) => events.push(event),
      planTimeoutMs: 1_000
    });
    const reviewed = await waitForEvent(events, "reviewed");

    expect(result.outcome).toBe("generated");
    expect(reviewed).toMatchObject({
      status: {
        state: "reviewed",
        agentId: "codex-desktop",
        runId: expect.stringMatching(/^run-/)
      },
      bundle: {
        source: "agent"
      }
    });
    expect((await readSequenceDiagrams(root))?.source).toBe("agent");
  });

  async function writeDesktopSequenceResponseWhenRunStarts(
    root: string,
    projectId: string,
    events: import("../../src/types").SequenceReviewEvent[]
  ): Promise<void> {
    const running = await waitForRunId(events);
    const runId = running.status.runId;
    if (!runId) throw new Error("Expected sequence review run id.");
    const inboxDir = join(root, FLOWWEAVE_DIR, "agent-inbox", "current");
    await waitForPath(join(inboxDir, "request.json"));
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      join(inboxDir, "response.json"),
      JSON.stringify({
        protocolVersion: 2,
        runId,
        projectId,
        status: "completed",
        summary: "desktop sequence response",
        content: JSON.stringify(validSequenceBundle(root)),
        completedAt: "2026-06-26T04:00:00.000Z"
      }),
      "utf8"
    );
  }

  async function waitForRunId(events: import("../../src/types").SequenceReviewEvent[]) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const event = events.find((candidate) => candidate.status.runId);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for sequence review run id.");
  }

  async function waitForPath(path: string) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await readFile(path, "utf8").then(() => true).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${path}.`);
  }

  it("regenerates local diagrams instead of reusing stale local cache", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-sequence-refresh-local-agent-"));
    const root = await createFixtureFiles();
    const flowweaveRoot = join(root, FLOWWEAVE_DIR);
    await mkdir(flowweaveRoot, { recursive: true });
    const staleLocal = { ...existingBundle(root), source: "local" as const };
    await writeFile(join(flowweaveRoot, "sequence-diagrams.json"), `${JSON.stringify(staleLocal, null, 2)}\n`, "utf8");
    const scriptPath = join(configRoot, "bad-sequence-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ architectural: { kind: 'architectural', participants: [], messages: [] } }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Refresh Local Sequence Agent",
      command: process.execPath,
      args: [scriptPath]
    });

    const result = await generateSequenceDiagrams(projectFixture(root), agent.id);
    const stored = JSON.parse(await readFile(join(flowweaveRoot, "sequence-diagrams.json"), "utf8")) as SequenceDiagramBundle;

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error("Expected refreshed local generation.");
    expect(result.warning).toBeUndefined();
    expect(result.bundle.source).toBe("local");
    expect(result.bundle.generatedAt).not.toBe(staleLocal.generatedAt);
    expect(stored.generatedAt).toBe(result.bundle.generatedAt);
    expect(stored.architectural.title).not.toBe("Existing Architectural");
  });

  it("reads legacy fallback bundles as local sequence diagrams", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    await writeFile(
      join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"),
      `${JSON.stringify({ ...existingBundle(root), source: "fallback" }, null, 2)}\n`,
      "utf8"
    );

    const bundle = await readSequenceDiagrams(root);

    expect(bundle?.source).toBe("local");
  });

  it("returns generated when valid output is parsed and written", async () => {
    const root = await createFixtureFiles();
    const result = await generateSequenceDiagrams(projectFixture(root), "mock");

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error(result.error.message);
    expect(result.bundle.source).toBe("agent");
  });

  it("reports and preserves a corrupted sequence diagram artifact", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    const artifactPath = join(root, FLOWWEAVE_DIR, "sequence-diagrams.json");
    await writeFile(artifactPath, "{invalid-json", "utf8");

    await expect(readSequenceDiagrams(root)).rejects.toThrow("unreadable and was preserved");
    await expect(readFile(artifactPath, "utf8")).resolves.toBe("{invalid-json");
  });

  it("reads legacy bundles that still contain detailed-design diagrams", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    const legacyBundle = {
      ...existingBundle(root),
      detailedDesign: {
        ...diagramJson([{ id: "legacy-detail", sequence: 1, from: "frontend-app", to: "api-gateway", kind: "sync", label: "Legacy detail" }]),
        id: "detailed-design-sequence",
        title: "Detailed Design Sequence Diagram",
        kind: "detailed-design"
      }
    };
    await writeFile(join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"), `${JSON.stringify(legacyBundle, null, 2)}\n`, "utf8");

    const bundle = await readSequenceDiagrams(root);

    expect(bundle?.architectural.title).toBe("Existing Architectural");
    expect("detailedDesign" in (bundle as object)).toBe(false);
  });

  it("revises the current diagram with the selected agent", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const generated = await generateSequenceDiagrams(project, "mock");
    if (generated.outcome !== "generated") throw new Error(generated.error.message);
    const revised = await reviseSequenceDiagram(project, "mock", "split payment into authorize and capture");
    const context = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "docs", "modification-context.json"), "utf8"));
    const guidance = await readFile(join(root, FLOWWEAVE_DIR, "docs", "modification-guidance.md"), "utf8");

    expect(generated.bundle.architectural.summary).not.toBe(revised.architectural.summary);
    expect(revised.architectural.summary).toContain("split payment into authorize and capture");
    expect(context.delta.sequenceInstruction).toBe("split payment into authorize and capture");
    expect(guidance).toContain("split payment into authorize and capture");
  });

  it("does not publish sequence artifacts after cancellation", async () => {
    const root = await createFixtureFiles();
    const controller = new AbortController();
    controller.abort("test-cancel");

    await expect(generateSequenceDiagrams(projectFixture(root), "mock", {
      signal: controller.signal
    })).rejects.toMatchObject({
      code: "operation-canceled"
    });
    await expect(readFile(join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

async function createFixtureFiles() {
  const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-"));
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "src/service"), { recursive: true });
  await writeFile(join(root, "src/api/order.controller.ts"), 'import { OrderService } from "../service/order.service";\nexport class OrderController { createOrder(dto: CreateOrderDto) { return new OrderService().createOrder(dto); } }\n', "utf8");
  await writeFile(join(root, "src/service/order.service.ts"), "export class OrderService { createOrder(dto: unknown) { return { id: 'order-1', dto }; } }\n", "utf8");
  await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
  await writeFile(join(root, FLOWWEAVE_DIR, "project.json"), JSON.stringify({ scanFingerprint: "scan-test" }), "utf8");
  return root;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sequence review event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForEvent(
  events: import("../../src/types").SequenceReviewEvent[],
  state: import("../../src/types").SequenceReviewState
): Promise<import("../../src/types").SequenceReviewEvent> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const event = events.find((candidate) => candidate.status.state === state);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for sequence review ${state} event.`);
}

function projectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "sequence-fixture",
    rootPath,
    generatedAt: "2026-05-31T00:00:00.000Z",
    scanFingerprint: "scan-test",
    git: { isRepo: false },
    summary: { totalFiles: 2, totalFolders: 3, languages: { TypeScript: 2 } },
    files: [
      {
        id: "src",
        name: "src",
        path: "src",
        type: "folder",
        depth: 0,
        children: [
          {
            id: "src/api",
            name: "api",
            path: "src/api",
            type: "folder",
            depth: 1,
            children: [{ id: "src/api/order.controller.ts", name: "order.controller.ts", path: "src/api/order.controller.ts", type: "file", depth: 2, language: "TypeScript" }]
          },
          {
            id: "src/service",
            name: "service",
            path: "src/service",
            type: "folder",
            depth: 1,
            children: [{ id: "src/service/order.service.ts", name: "order.service.ts", path: "src/service/order.service.ts", type: "file", depth: 2, language: "TypeScript" }]
          }
        ]
      }
    ]
  };
}

function diagramJson(messages: unknown[]) {
  return {
    id: "architectural-sequence",
    title: "Architectural Sequence Diagram",
    kind: "architectural",
    summary: "Fixture diagram.",
    participants: [
      { id: "frontend-app", title: "Frontend App", kind: "actor", description: "Starts the order flow." },
      { id: "api-gateway", title: "API Gateway", kind: "gateway", description: "Receives order requests." }
    ],
    messages,
    evidence: []
  };
}

function existingBundle(rootPath: string): SequenceDiagramBundle {
  return {
    version: 1,
    projectName: "sequence-fixture",
    rootPath,
    generatedAt: "2026-05-31T01:00:00.000Z",
    source: "agent",
    architectural: {
      ...diagramJson([{ id: "existing-message", sequence: 1, from: "frontend-app", to: "api-gateway", kind: "sync", label: "Existing call" }]),
      title: "Existing Architectural"
    }
  };
}

function validSequenceBundle(rootPath: string): SequenceDiagramBundle {
  return {
    version: 1,
    projectName: "sequence-fixture",
    rootPath,
    generatedAt: "2026-06-26T04:00:00.000Z",
    source: "agent",
    architectural: {
      id: "architectural-sequence",
      title: "Architectural Sequence Diagram",
      kind: "architectural",
      summary: "Order request flows from the API controller into the order service.",
      participants: [
        {
          id: "order-controller",
          title: "Order Controller",
          kind: "gateway",
          description: "Receives order creation requests.",
          filePath: "src/api/order.controller.ts",
          symbol: "OrderController"
        },
        {
          id: "order-service",
          title: "Order Service",
          kind: "service",
          description: "Creates orders.",
          filePath: "src/service/order.service.ts",
          symbol: "OrderService"
        }
      ],
      messages: [
        {
          id: "controller-calls-service",
          sequence: 1,
          from: "order-controller",
          to: "order-service",
          kind: "sync",
          label: "Create order",
          description: "The controller delegates order creation to the service.",
          methodName: "createOrder",
          input: "CreateOrderDto",
          output: "Order",
          evidence: [
            {
              filePath: "src/api/order.controller.ts",
              symbol: "OrderController",
              detail: "OrderController.createOrder constructs OrderService and calls createOrder."
            }
          ]
        }
      ],
      evidence: [
        {
          filePath: "src/service/order.service.ts",
          symbol: "OrderService",
          detail: "OrderService.createOrder returns an order result."
        }
      ]
    }
  };
}

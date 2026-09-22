import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureAgentRegistry, saveCustomAgent } from "../../src/main/services/agent-registry.service";
import {
  SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS,
  SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS,
  SequenceDiagramPromptBudgetExceededError,
  buildSequenceDiagramRevisionPrompt,
  buildSequenceDiagramPrompt,
  generateSequenceDiagrams,
  parseSequenceDiagramBundleJson,
  readSequenceDiagrams,
  reviseSequenceDiagram,
  writeSequenceDiagramBundle
} from "../../src/main/services/sequence-diagram.service";
import { registerProject } from "../../src/main/services/project-registry.service";
import { buildProjectStructureFacts } from "../../src/main/services/structure-extractor.service";
import { installBuiltInAgentPlugin } from "../../src/main/services/agent-plugin.service";
import { enableProjectAgentConnection } from "../../src/main/services/project-agent-connection.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import type { CodeflowProject, SequenceDiagram, SequenceDiagramBundle } from "../../src/types";

describe("sequence-diagram.service", () => {
  it("builds a prompt for architectural diagrams only", () => {
    const diagram = diagramJson([
      {
        id: "controller-service",
        sequence: 1,
        from: "frontend-app",
        to: "api-gateway",
        kind: "sync",
        label: "POST /orders",
        evidence: [{ filePath: "src/api/order.controller.ts", symbol: "OrderController", line: 42, detail: "Calls OrderService.createOrder." }]
      }
    ]) as SequenceDiagram;
    const prompt = buildSequenceDiagramPrompt("sequence-fixture", diagram);
    const input = JSON.parse(prompt.text.match(/Input: (.+)\n\nReturn shape:/)?.[1] ?? "{}") as {
      evidence: Array<[string | undefined, string | undefined, number | null, string]>;
    };
    const schema = JSON.parse(prompt.text.match(/Return shape:\n(.+)\n\nCreate a detailed/s)?.[1] ?? "{}") as {
      architectural?: { messages?: Array<{ evidence?: Array<{ line?: number }> }> };
    };

    expect(prompt.text).toContain("Architectural Sequence Diagram");
    expect(prompt.text).toContain("detailed architectural sequence");
    expect(prompt.text).not.toContain("Detailed Design Sequence Diagram");
    expect(prompt.text).not.toContain('"detailedDesign"');
    expect(prompt.text).not.toContain("ProjectStructureFacts");
    expect(prompt.text).toContain("src/api/order.controller.ts");
    expect(prompt.text).toContain("end-to-end workflow");
    expect(prompt.text).not.toContain("code-level call sequence");
    expect(prompt.text).toContain("entry/user action");
    expect(prompt.text).toContain("IPC/API boundary");
    expect(prompt.text).toContain("do not return detailedDesign");
    expect(prompt.text).toContain("Prefer 6-14 participants and 8-24 messages");
    expect(prompt.text).toContain("methodName");
    expect(prompt.text).toContain("input");
    expect(prompt.text).toContain("output");
    expect(prompt.text).toContain("valid participant ids");
    expect(prompt.text).toContain("do not invent files, symbols, calls, endpoints, databases, queues or third-party systems");
    expect(prompt.metrics.promptChars).toBeLessThanOrEqual(SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS);
    expect(prompt.metrics.promptEvidenceCount).toBe(1);
    expect(prompt.metrics.promptEvidenceOmittedCount).toBe(0);
    expect(input.evidence[0][2]).toBe(42);
    expect(schema.architectural?.messages?.[0]?.evidence?.[0]?.line).toBe(12);
  });

  it("reserves evidence for every supported message before filling the soft budget", () => {
    const messages = Array.from({ length: 24 }, (_, index) => ({
      id: `message-${index}`,
      sequence: index + 1,
      from: "frontend-app",
      to: "api-gateway",
      kind: "sync",
      label: `call-${index}`,
      evidence: [{ filePath: `src/file-${index}.ts`, symbol: `symbol${index}`, detail: `oversized-evidence-${index} ${"detail ".repeat(100)}` }]
    }));
    const diagram = diagramJson(messages) as SequenceDiagram;

    const prompt = buildSequenceDiagramPrompt("sequence-fixture", diagram);
    const input = JSON.parse(prompt.text.match(/Input: (.+)\n\nReturn shape:/)?.[1] ?? "{}") as {
      messages: Array<unknown[]>;
      evidence: unknown[];
    };

    expect(prompt.metrics.promptChars).toBeLessThanOrEqual(SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS);
    expect(prompt.metrics.promptEvidenceCount).toBe(24);
    expect(prompt.metrics.promptEvidenceOmittedCount).toBe(0);
    expect(prompt.metrics.promptEvidenceTruncatedCount).toBe(24);
    expect(input.messages).toHaveLength(24);
    expect(input.messages.every((message) => Array.isArray(message.at(-1)) && (message.at(-1) as unknown[]).length > 0)).toBe(true);
    expect(input.evidence).toHaveLength(24);
    expect(prompt.text).toContain('"message-23"');
    expect(prompt.text).toContain("fromParticipantIndex");
  });

  it("keeps every evidence-backed message when mandatory evidence exceeds the soft target", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `supported-message-${index}`,
      sequence: index + 1,
      from: "frontend-app",
      to: "api-gateway",
      kind: "sync" as const,
      label: `stage-${index}`,
      description: `D${index}${"d".repeat(112)}`,
      evidence: [{
        filePath: `src/${index}.ts`,
        symbol: `E${index}`,
        detail: `E${index}${"e".repeat(60)}`
      }]
    }));
    const diagram = diagramJson(messages) as SequenceDiagram;

    const prompt = buildSequenceDiagramPrompt("sequence-fixture", diagram);
    const input = JSON.parse(prompt.text.match(/Input: (.+)\n\nReturn shape:/)?.[1] ?? "{}") as {
      messages: unknown[][];
      evidence: unknown[];
    };
    const references = input.messages.map((message) => message.at(-1));

    expect(prompt.metrics.promptChars).toBeGreaterThan(SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS);
    expect(prompt.metrics.promptChars).toBeLessThanOrEqual(SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS);
    expect(prompt.metrics.promptMessageCount).toBe(40);
    expect(prompt.metrics.promptMessageOmittedCount).toBe(0);
    expect(input.messages).toHaveLength(40);
    expect(references.every((value) => Array.isArray(value) && value.length > 0)).toBe(true);
    expect(references.flat().every((index) => typeof index === "number" && index >= 0 && index < input.evidence.length)).toBe(true);
    const repeated = buildSequenceDiagramPrompt("sequence-fixture", diagram);
    expect(repeated.text).toBe(prompt.text);
    expect(repeated.metrics).toEqual(prompt.metrics);
  });

  it("reports mandatory message and evidence sizes when the hard budget is exceeded", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `oversized-message-${index}`,
      sequence: index + 1,
      from: "frontend-app",
      to: "api-gateway",
      kind: "sync" as const,
      label: `stage-${index}`,
      description: "d".repeat(500),
      evidence: [{ filePath: `src/${index}.ts`, symbol: `E${index}`, detail: "valid source evidence" }]
    }));
    const diagram = diagramJson(messages) as SequenceDiagram;
    let thrown: unknown;

    try {
      buildSequenceDiagramPrompt("sequence-fixture", diagram);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SequenceDiagramPromptBudgetExceededError);
    expect(thrown).toMatchObject({
      code: "SEQUENCE_DIAGRAM_PROMPT_BUDGET_EXCEEDED",
      actualChars: expect.any(Number),
      diagnostics: {
        participantCount: 2,
        messageCount: 40,
        mandatoryEvidenceCount: 40,
        largestEvidenceContribution: {
          chars: expect.any(Number),
          filePath: expect.any(String)
        }
      }
    });
    if (!(thrown instanceof SequenceDiagramPromptBudgetExceededError)) {
      throw new Error("Expected a sequence diagram prompt budget error.");
    }
    expect(thrown.actualChars).toBeGreaterThan(SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS);
    expect(thrown.budgetChars).toBe(SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS);
  });

  it("reports the participant and message counts that are present in the compact prompt", () => {
    const diagram = diagramJson([
      {
        id: "supported-message",
        sequence: 1,
        from: "frontend-app",
        to: "api-gateway",
        kind: "sync",
        label: "supported",
        evidence: [{ filePath: "src/supported.ts", symbol: "supported", detail: "Supported behavior." }]
      },
      {
        id: "unsupported-message",
        sequence: 2,
        from: "frontend-app",
        to: "api-gateway",
        kind: "sync",
        label: "unsupported"
      }
    ]) as SequenceDiagram;

    const prompt = buildSequenceDiagramPrompt("sequence-fixture", diagram);
    const input = JSON.parse(prompt.text.match(/Input: (.+)\n\nReturn shape:/)?.[1] ?? "{}") as {
      participants: unknown[];
      messages: unknown[][];
    };

    expect(prompt.metrics.promptParticipantCount).toBe(input.participants.length);
    expect(prompt.metrics.promptMessageCount).toBe(input.messages.length);
    expect(prompt.metrics.promptMessageOmittedCount + input.messages.length).toBe(diagram.messages.length);
    expect(prompt.metrics.promptMessageCount).toBe(1);
    expect(prompt.metrics.promptMessageOmittedCount).toBe(1);
    expect(input.messages.map((message) => message[0])).toEqual(["supported-message"]);
  });

  it("builds deterministic prompts for forty messages with thirty unique evidence items each", () => {
    const participants = Array.from({ length: 14 }, (_, index) => ({
      id: `module-${index}`,
      title: `Module ${index}`,
      kind: "service" as const,
      description: `Handles workflow stage ${index}.`,
      filePath: `src/module-${index}.ts`,
      symbol: `Module${index}`
    }));
    const messages = Array.from({ length: 40 }, (_, messageIndex) => ({
      id: `message-${messageIndex}`,
      sequence: messageIndex + 1,
      from: participants[messageIndex % participants.length].id,
      to: participants[(messageIndex + 1) % participants.length].id,
      kind: "sync" as const,
      label: `Run stage ${messageIndex}`,
      description: `Routes stage ${messageIndex} through the next service.`,
      evidence: Array.from({ length: 30 }, (_, evidenceIndex) => ({
        filePath: `src/stages/${messageIndex}/evidence-${evidenceIndex}.ts`,
        symbol: `stage${messageIndex}Evidence${evidenceIndex}`,
        detail: `Evidence ${evidenceIndex} supports stage ${messageIndex}.`
      }))
    }));
    const diagram = {
      ...diagramJson(messages),
      participants,
      evidence: [{ filePath: "src/main.ts", symbol: "main", detail: "The entry point begins the workflow." }]
    } as SequenceDiagram;

    const first = buildSequenceDiagramPrompt("sequence-scale-fixture", diagram);
    const second = buildSequenceDiagramPrompt("sequence-scale-fixture", diagram);
    const parseInput = (text: string) => JSON.parse(text.match(/Input: (.+)\n\nReturn shape:/)?.[1] ?? "{}") as {
      messages: unknown[][];
      evidence: unknown[];
    };
    const input = parseInput(first.text);
    const evidenceReferences = input.messages.map((message) => message.at(-1));

    expect(first.metrics.promptChars).toBeLessThanOrEqual(SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS);
    expect(first.metrics.promptMessageCount).toBe(input.messages.length);
    expect(first.metrics.promptMessageOmittedCount + input.messages.length).toBe(diagram.messages.length);
    expect(input.messages).toHaveLength(40);
    expect(evidenceReferences.every((references) => Array.isArray(references) && references.length > 0)).toBe(true);
    expect(evidenceReferences.flat().every((index) => typeof index === "number" && index >= 0 && index < input.evidence.length)).toBe(true);
    expect(first.text).toBe(second.text);
    expect(parseInput(first.text).evidence).toEqual(parseInput(second.text).evidence);
    expect(first.metrics).toEqual(second.metrics);
  }, 60_000);

  it("fails explicitly when the sequence diagram core exceeds its hard budget", () => {
    const diagram = { ...diagramJson([]), summary: "x".repeat(SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS) } as SequenceDiagram;

    expect(() => buildSequenceDiagramPrompt("sequence-fixture", diagram)).toThrow(
      /SEQUENCE_DIAGRAM_PROMPT_BUDGET_EXCEEDED: actualChars=\d+ budget=16000/
    );
  });

  it("builds a revision prompt that preserves evidence and returns a complete diagram", async () => {
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
    current.participants = [
      { id: "order-controller", title: "Order Controller", kind: "gateway", description: "Receives requests.", filePath: "src/api/order.controller.ts", symbol: "OrderController" },
      { id: "order-service", title: "Order Service", kind: "service", description: "Creates orders.", filePath: "src/service/order.service.ts", symbol: "OrderService" }
    ];
    const prompt = buildSequenceDiagramRevisionPrompt(current, "include validation before creating the order");

    expect(prompt.text).toContain("Preserve reliable existing evidence");
    expect(prompt.text).toContain("Return the complete updated diagram object");
    expect(prompt.text).toMatch(/keep kind exactly "architectural"/i);
    expect(prompt.text).toContain("Update participants and messages together");
    expect(prompt.text).toContain("methodName");
    expect(prompt.text).toContain("input");
    expect(prompt.text).toContain("output");
    expect(prompt.metrics.promptChars).toBeLessThanOrEqual(SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS);
    expect(prompt.text).not.toContain("ProjectStructureFacts");
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

  it("publishes a review-failed event after its single Agent response is rejected", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-sequence-review-failed-"));
    const root = await createFixtureFiles();
    const invocationPath = join(configRoot, "invocations.txt");
    const scriptPath = join(configRoot, "bad-sequence-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        `  appendFileSync(${JSON.stringify(invocationPath)}, 'x');`,
        "  console.log(JSON.stringify({ architectural: { kind: 'architectural', participants: [], messages: [] } }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Rejected Sequence Review Agent",
      command: process.execPath,
      args: [scriptPath],
      capabilities: ["artifact-analysis"]
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
    expect(await readFile(invocationPath, "utf8")).toBe("x");
  });

  it("waits for Agent Inbox response.json before completing sequence review", async () => {
    const root = await createFixtureFiles();
    const projectId = await registerProject(root);
    await installBuiltInAgentPlugin(root);
    await enableProjectAgentConnection(root);
    const events: import("../../src/types").SequenceReviewEvent[] = [];

    void writeDesktopSequenceResponseWhenRunStarts(root, projectId, events);

    const result = await generateSequenceDiagrams(projectFixture(root), "codex-desktop", {
      projectId,
      onSequenceReview: (event) => events.push(event),
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
    await waitForPath(join(root, FLOWWEAVE_DIR, "runs", runId, "agent-request.json"));
    await mkdir(join(root, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
    await writeFile(
      join(root, ".flowweave", "runs", runId, "agent-response.json"),
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

  it("rejects v1 sequence bundles and requires regeneration", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    await writeFile(
      join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"),
      `${JSON.stringify({ ...existingBundle(root), version: 1 }, null, 2)}\n`,
      "utf8"
    );

    await expect(readSequenceDiagrams(root)).rejects.toThrow("must be v2. Regenerate it");
  });

  it("does not overwrite a v1 sequence bundle during v2 generation", async () => {
    const root = await createFixtureFiles();
    const artifactPath = join(root, FLOWWEAVE_DIR, "sequence-diagrams.json");
    const legacy = `${JSON.stringify({ ...existingBundle(root), version: 1 }, null, 2)}\n`;
    await writeFile(artifactPath, legacy, "utf8");

    await expect(writeSequenceDiagramBundle(root, existingBundle(root), undefined)).rejects.toThrow("must be v2. Regenerate it");
    await expect(readFile(artifactPath, "utf8")).resolves.toBe(legacy);
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

  it("writes sequence diagram bundles as v2 artifacts", async () => {
    const root = await createFixtureFiles();
    const bundle = existingBundle(root);

    await writeSequenceDiagramBundle(root, bundle, undefined);

    const stored = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"), "utf8")) as { version: number };
    expect(stored.version).toBe(2);
  });

  it("reads a v2 sequence bundle without compatibility rewriting", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    const storedBundle = {
      ...existingBundle(root),
      source: "agent" as const
    };
    await writeFile(join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"), `${JSON.stringify(storedBundle, null, 2)}\n`, "utf8");

    const bundle = await readSequenceDiagrams(root);

    expect(bundle).toEqual(storedBundle);
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

});

async function createFixtureFiles() {
  const root = await mkdtemp(join(tmpdir(), "flowweave-sequence-"));
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "src/service"), { recursive: true });
  await writeFile(join(root, "src/api/order.controller.ts"), 'import { OrderService } from "../service/order.service";\nexport class OrderController { createOrder(dto: CreateOrderDto) { return new OrderService().createOrder(dto); } }\n', "utf8");
  await writeFile(join(root, "src/service/order.service.ts"), "export class OrderService { createOrder(dto: unknown) { return { id: 'order-1', dto }; } }\n", "utf8");
  await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
  const project: CodeflowProject = {
    version: 1,
    projectName: "sequence-fixture",
    rootPath: root,
    generatedAt: new Date().toISOString(),
    scanFingerprint: "scan-test",
    git: { isRepo: false },
    summary: { totalFiles: 2, totalFolders: 3, languages: { TypeScript: 2 } },
    files: []
  };
  await writeFile(join(root, FLOWWEAVE_DIR, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
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
    version: 2,
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
    version: 2,
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

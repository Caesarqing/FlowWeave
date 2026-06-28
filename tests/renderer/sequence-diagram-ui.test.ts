import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSequenceFlowNodes, filterSequenceDiagram } from "../../src/utils/sequence-diagram-flow";
import { buildAgentPrompt, buildModificationContext, buildSequenceGuidanceMarkdown, buildSequencePlanPrompt, buildSequenceTaskJson } from "../../src/utils/export-artifacts";
import { sequenceArtifactStateFromGenerationResult } from "../../src/hooks/useSequenceDiagramState";
import type { SequenceDiagramBundle } from "../../src/types";

const structureWorkspaceSource = readFileSync(
  new URL("../../src/components/StructureWorkspace.tsx", import.meta.url),
  "utf8"
);
const sequenceStateSource = readFileSync(
  new URL("../../src/hooks/useSequenceDiagramState.ts", import.meta.url),
  "utf8"
);

describe("sequence diagram UI helpers", () => {
  it("lays out participants as vertical lanes and messages by sequence", () => {
    const nodes = buildSequenceFlowNodes(bundleFixture().architectural);

    const client = nodes.find((node) => node.id === "participant:client");
    const server = nodes.find((node) => node.id === "participant:server");
    const firstMessage = nodes.find((node) => node.id === "message:send-order");
    const secondMessage = nodes.find((node) => node.id === "message:return-session");

    expect(client?.position).toEqual({ x: 35, y: 0 });
    expect(server?.position).toEqual({ x: 295, y: 0 });
    expect(firstMessage?.position.y).toBeLessThan(secondMessage?.position.y ?? 0);
    expect(firstMessage?.position.x).toBe(53);
    expect(firstMessage?.data).toMatchObject({
      direction: "forward",
      fromTitle: "Client",
      toTitle: "Server"
    });
    expect(secondMessage?.data).toMatchObject({ direction: "backward" });
  });

  it("exports the architectural sequence diagram with method contracts and evidence", () => {
    const bundle = bundleFixture();
    const markdown = buildSequenceGuidanceMarkdown("Checkout", bundle);
    const task = JSON.parse(buildSequenceTaskJson("Checkout", bundle));

    expect(markdown).toContain("Architectural Checkout");
    expect(markdown).toContain("method=createCheckoutSession");
    expect(markdown).toContain("src/orders/controller.ts:OrderController.create");
    expect(task.diagrams.architectural.messages[0].input).toBe("OrderInput");
    expect(task.diagrams.detailedDesign).toBeUndefined();
  });

  it("builds a sequence agent prompt from JSON context", () => {
    const context = buildModificationContext({
      projectLabel: "Checkout",
      nodes: [],
      edges: [],
      sequenceBundle: bundleFixture(),
      sequenceInstruction: "Split payment into authorize and capture"
    });
    const prompt = buildAgentPrompt(context, "sequence-revision", "plan");
    const legacyPrompt = buildSequencePlanPrompt("Checkout", bundleFixture());

    expect(prompt).toContain("Prompt kind: sequence-revision");
    expect(prompt).toContain("Context JSON:");
    expect(prompt).toContain("Split payment into authorize and capture");
    expect(prompt).toContain("Architectural Checkout");
    expect(legacyPrompt).toContain("Prompt kind: sequence-revision");
  });

  it("filters messages by kind and keeps only their participant endpoints", () => {
    const filtered = filterSequenceDiagram(bundleFixture().architectural, "", new Set(["return"]));

    expect(filtered.messages.map((message) => message.id)).toEqual(["return-session"]);
    expect(filtered.participants.map((participant) => participant.id)).toEqual(["server", "stripe"]);
  });

  it("searches participant metadata and retains messages connected to matches", () => {
    const filtered = filterSequenceDiagram(bundleFixture().architectural, "Buyer", new Set());

    expect(filtered.messages.map((message) => message.id)).toEqual(["send-order"]);
    expect(filtered.participants.map((participant) => participant.id)).toEqual([
      "client",
      "server"
    ]);
    expect(bundleFixture().architectural.participants).toHaveLength(3);
  });

  it("returns an empty view when no participant or message matches the search", () => {
    const filtered = filterSequenceDiagram(bundleFixture().architectural, "missing participant", new Set());

    expect(filtered.participants).toEqual([]);
    expect(filtered.messages).toEqual([]);
  });

  it("keeps zoom controls inside the viewport for the architecture diagram", () => {
    expect(structureWorkspaceSource).toContain("<Controls position=\"bottom-left\" showFitView showInteractive={false} showZoom />");
    expect(structureWorkspaceSource).toContain('<div className="sequence-canvas-stage">');
    expect(structureWorkspaceSource).toContain('key={canvasKey}');
    expect(structureWorkspaceSource).toContain('canvasKey={sequence.bundle?.generatedAt ?? visibleDiagram.id}');
    expect(structureWorkspaceSource).not.toContain("detailed-design");
    expect(structureWorkspaceSource).not.toContain("structure.diagramType");
    expect(structureWorkspaceSource).not.toContain("segmented-control");
    expect(structureWorkspaceSource).not.toContain("style={{ minWidth: bounds.width, minHeight: bounds.height }}");
  });

  it("marks local sequence generation as a current artifact state", () => {
    const bundle = bundleFixture();

    expect(sequenceArtifactStateFromGenerationResult({ outcome: "generated", bundle })).toBe("current");
    expect(sequenceArtifactStateFromGenerationResult({
      outcome: "generated",
      bundle: { ...bundle, source: "local" },
      warning: failureFixture()
    })).toBe("current");
    expect(sequenceArtifactStateFromGenerationResult({
      outcome: "cached",
      bundle,
      error: failureFixture()
    })).toBe("current");
  });

  it("passes the configured plan timeout into sequence agent runs", () => {
    expect(sequenceStateSource).toContain("planTimeoutMinutes * 60_000");
    expect(sequenceStateSource).toContain("generateSequenceDiagrams(projectId, runAgentId, planTimeoutMinutes * 60_000)");
    expect(sequenceStateSource).toContain("reviseSequenceDiagram(projectId, selectedAgentId, instruction.trim(), planTimeoutMinutes * 60_000)");
  });
});

function bundleFixture(): SequenceDiagramBundle {
  return {
    version: 1,
    projectName: "Checkout",
    rootPath: "/tmp/checkout",
    generatedAt: "2026-05-31T00:00:00.000Z",
    source: "agent",
    architectural: {
      id: "arch",
      title: "Architectural Checkout",
      kind: "architectural",
      summary: "Checkout flow",
      participants: [
        { id: "client", title: "Client", kind: "actor", description: "Buyer" },
        {
          id: "server",
          title: "Server",
          kind: "service",
          description: "Backend",
          filePath: "src/orders/controller.ts",
          symbol: "OrderController.create"
        },
        { id: "stripe", title: "Stripe API", kind: "external", description: "Payment API" }
      ],
      messages: [
        {
          id: "send-order",
          sequence: 1,
          from: "client",
          to: "server",
          kind: "sync",
          label: "Send order information",
          input: "OrderInput",
          output: "CheckoutSession",
          evidence: [
            {
              filePath: "src/orders/controller.ts",
              symbol: "OrderController.create",
              detail: "Controller delegates order creation."
            }
          ]
        },
        {
          id: "return-session",
          sequence: 2,
          from: "stripe",
          to: "server",
          kind: "return",
          label: "Return Checkout Session",
          methodName: "createCheckoutSession"
        }
      ]
    }
  };
}

function failureFixture() {
  return {
    code: "invalid-output" as const,
    message: "Agent returned invalid sequence diagram JSON.",
    agentId: "mock" as const
  };
}

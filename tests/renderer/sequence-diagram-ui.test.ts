import { describe, expect, it } from "vitest";
import { buildSequenceFlowNodes } from "../../src/utils/sequence-diagram-flow";
import { buildSequenceGuidanceMarkdown, buildSequencePlanPrompt, buildSequenceTaskJson } from "../../src/utils/export-artifacts";
import type { SequenceDiagramBundle } from "../../src/types";

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

  it("exports both sequence diagram types with method contracts and evidence", () => {
    const bundle = bundleFixture();
    const markdown = buildSequenceGuidanceMarkdown("Checkout", bundle, "architectural");
    const task = JSON.parse(buildSequenceTaskJson("Checkout", bundle, "detailed-design"));

    expect(markdown).toContain("Architectural Checkout");
    expect(markdown).toContain("Detailed Checkout");
    expect(markdown).toContain("method=createCheckoutSession");
    expect(markdown).toContain("src/orders/controller.ts:OrderController.create");
    expect(task.diagrams.architectural.messages[0].input).toBe("OrderInput");
    expect(task.diagrams.detailedDesign.messages[0].methodName).toBe("create");
  });

  it("builds a sequence agent plan prompt without a selected canvas node", () => {
    const prompt = buildSequencePlanPrompt("Checkout", bundleFixture(), "detailed-design");

    expect(prompt).toContain("Do not require a selected Canvas module node");
    expect(prompt).toContain("Detailed Checkout");
    expect(prompt).not.toContain('module "');
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
        { id: "server", title: "Server", kind: "service", description: "Backend" },
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
          output: "CheckoutSession"
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
    },
    detailedDesign: {
      id: "detail",
      title: "Detailed Checkout",
      kind: "detailed-design",
      summary: "Controller to service flow",
      participants: [
        {
          id: "order-controller",
          title: "OrderController",
          kind: "controller",
          description: "HTTP controller",
          filePath: "src/orders/controller.ts",
          symbol: "OrderController"
        },
        {
          id: "checkout-service",
          title: "CheckoutService",
          kind: "class",
          description: "Checkout orchestration",
          filePath: "src/checkout/service.ts",
          symbol: "CheckoutService"
        }
      ],
      messages: [
        {
          id: "create",
          sequence: 1,
          from: "order-controller",
          to: "checkout-service",
          kind: "sync",
          label: "create order",
          methodName: "create",
          input: "CreateOrderDto",
          output: "Promise<Order>",
          evidence: [
            {
              filePath: "src/orders/controller.ts",
              symbol: "OrderController.create",
              detail: "Controller delegates order creation."
            }
          ]
        }
      ]
    }
  };
}

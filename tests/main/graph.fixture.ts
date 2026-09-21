import type { FileInsight, GraphEdge, GraphNode, SemanticRelation } from "../../src/types";

export const graphNodes: GraphNode[] = [
  {
    id: "user-api",
    title: "User API",
    subtitle: "HTTP endpoints",
    kind: "module",
    nodeType: "module",
    risk: "low",
    description: "Handles user requests.",
    files: ["apps/api/src/user/user.controller.ts"],
    guidanceDraft: "Keep request handling narrow.",
    status: "mapped",
    x: 0,
    y: 0
  },
  {
    id: "tests",
    title: "Tests",
    subtitle: "Regression coverage",
    kind: "module",
    nodeType: "test",
    risk: "low",
    description: "Covers user behavior.",
    files: ["tests/user.api.test.ts"],
    guidanceDraft: "Run regression tests.",
    status: "mapped",
    x: 240,
    y: 0
  }
];

export const graphEdges: GraphEdge[] = [
  { id: "user-api-tests", source: "user-api", target: "tests", relation: "tests" }
];

export const moduleClusteringFixture: {
  files: FileInsight[];
  relations: SemanticRelation[];
} = {
  files: [
    clusteringFile("src/features/billing/BillingPanel.tsx"),
    clusteringFile("src/features/billing/billing.ipc.ts"),
    clusteringFile("src/features/billing/billing.service.ts"),
    clusteringFile("src/features/billing/storage/invoice.repository.ts"),
    clusteringFile("src/main/services/billing-format.ts"),
    clusteringFile("src/features/identity/IdentityPanel.tsx"),
    clusteringFile("src/features/identity/identity.service.ts"),
    clusteringFile("src/features/notifications/notifications.worker.ts"),
    clusteringFile("src/integrations/stripe/stripe.adapter.ts"),
    clusteringFile("tests/billing.service.test.ts"),
    clusteringFile("src/shared/date.util.ts")
  ],
  relations: [
    clusteringRelation("billing-date", "call", "src/features/billing/billing.service.ts", "src/shared/date.util.ts"),
    clusteringRelation("billing-format", "call", "src/features/billing/billing.service.ts", "src/main/services/billing-format.ts"),
    clusteringRelation("identity-date", "call", "src/features/identity/identity.service.ts", "src/shared/date.util.ts"),
    clusteringRelation("notifications-date", "call", "src/features/notifications/notifications.worker.ts", "src/shared/date.util.ts")
  ]
};

function clusteringFile(path: string): FileInsight {
  return { path, imports: [], exports: [], symbols: [], calls: [], externalCalls: [] };
}

function clusteringRelation(
  id: string,
  kind: SemanticRelation["kind"],
  sourceFile: string,
  targetFile: string
): SemanticRelation {
  return {
    id,
    kind,
    source: sourceFile,
    target: targetFile,
    sourceFile,
    targetFile,
    detail: `${sourceFile} references ${targetFile}`,
    confidence: "confirmed"
  };
}

import type { GraphEdge, GraphNode } from "../../src/types";

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

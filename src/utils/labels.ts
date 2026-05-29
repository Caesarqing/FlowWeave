import type { GraphEdgeRelation, GraphNode } from "../types";

export const relationLabel: Record<GraphEdgeRelation, string> = {
  depends_on: "depends on",
  calls: "calls",
  reads_writes: "reads/writes",
  tests: "tests"
};

export const riskLabel: Record<GraphNode["risk"], string> = {
  normal: "normal",
  review: "review",
  blocked: "blocked"
};

export const nodeTypeLabel: Record<GraphNode["nodeType"], string> = {
  entrypoint: "entrypoint",
  module: "module",
  data: "data",
  test: "test"
};

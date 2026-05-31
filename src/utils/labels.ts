import type { GraphEdgeRelation, GraphNode } from "../types";

export const relationLabel: Record<GraphEdgeRelation, string> = {
  depends_on: "depends on",
  calls: "calls",
  reads_writes: "reads/writes",
  external_api: "external API",
  publishes_event: "publishes",
  subscribes_event: "subscribes",
  tests: "tests"
};

export const riskLabel: Record<GraphNode["risk"], string> = {
  normal: "normal",
  review: "review",
  blocked: "blocked"
};

export const nodeTypeLabel: Record<GraphNode["nodeType"], string> = {
  entrypoint: "entrypoint",
  api: "api boundary",
  service: "domain service",
  module: "module",
  external: "external integration",
  worker: "job/worker",
  utility: "utility",
  data: "data",
  test: "test"
};

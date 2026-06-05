import type { GraphEdgeRelation } from "../types";

export const relationOptions: GraphEdgeRelation[] = [
  "depends_on",
  "calls",
  "reads_writes",
  "external_api",
  "publishes_event",
  "subscribes_event",
  "tests"
];

export const relationStyle: Record<GraphEdgeRelation, { color: string }> = {
  depends_on: {
    color: "#89ecff"
  },
  calls: {
    color: "#42f5a7"
  },
  reads_writes: {
    color: "#fbbf24"
  },
  external_api: {
    color: "#a78bfa"
  },
  publishes_event: {
    color: "#a3e635"
  },
  subscribes_event: {
    color: "#22d3ee"
  },
  tests: {
    color: "#fb7185"
  }
};

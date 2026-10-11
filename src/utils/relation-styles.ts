import type { GraphEdgeClass, GraphEdgeRelation } from "../types";

export const relationOptions: GraphEdgeRelation[] = [
  "depends_on",
  "calls",
  "reads",
  "writes",
  "reads_writes",
  "http_contract",
  "process_invocation",
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
  reads: {
    color: "#fbbf24"
  },
  writes: {
    color: "#f59e0b"
  },
  reads_writes: {
    color: "#fbbf24"
  },
  http_contract: {
    color: "#60a5fa"
  },
  process_invocation: {
    color: "#34d399"
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

export const relationEdgeClass: Record<GraphEdgeRelation, GraphEdgeClass> = {
  depends_on: "dependency",
  calls: "runtime",
  reads: "data",
  writes: "data",
  reads_writes: "data",
  http_contract: "external",
  process_invocation: "runtime",
  external_api: "external",
  publishes_event: "event",
  subscribes_event: "event",
  tests: "test"
};

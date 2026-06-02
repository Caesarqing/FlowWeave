import type { GraphEdgeRelation, GraphNode } from "../types";

export const relationLabel: Record<GraphEdgeRelation, string> = {
  depends_on: "依赖",
  calls: "调用",
  reads_writes: "读写数据",
  external_api: "外部 API",
  publishes_event: "发布事件",
  subscribes_event: "订阅事件",
  tests: "测试覆盖"
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

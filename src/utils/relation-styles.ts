import type { GraphEdgeRelation } from "../types";
import { relationLabel } from "./labels";

export const relationOptions: GraphEdgeRelation[] = [
  "depends_on",
  "calls",
  "reads_writes",
  "external_api",
  "publishes_event",
  "subscribes_event",
  "tests"
];

export const relationStyle: Record<GraphEdgeRelation, { label: string; color: string; accent: string }> = {
  depends_on: { label: relationLabel.depends_on, color: "#89ecff", accent: "淡蓝依赖" },
  calls: { label: relationLabel.calls, color: "#42f5a7", accent: "调用" },
  reads_writes: { label: relationLabel.reads_writes, color: "#fbbf24", accent: "读写" },
  external_api: { label: relationLabel.external_api, color: "#a78bfa", accent: "外部 API" },
  publishes_event: { label: relationLabel.publishes_event, color: "#a3e635", accent: "发布事件" },
  subscribes_event: { label: relationLabel.subscribes_event, color: "#22d3ee", accent: "订阅事件" },
  tests: { label: relationLabel.tests, color: "#fb7185", accent: "测试" }
};

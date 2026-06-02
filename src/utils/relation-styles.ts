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

export const relationStyle: Record<GraphEdgeRelation, { label: string; color: string; accent: string; description: string }> = {
  depends_on: {
    label: relationLabel.depends_on,
    color: "#89ecff",
    accent: "依赖",
    description: "模块通过 import、配置、类型、框架注册或运行前置条件依赖目标模块。"
  },
  calls: {
    label: relationLabel.calls,
    color: "#42f5a7",
    accent: "调用",
    description: "源模块会直接调用目标模块的接口、函数、类方法或服务方法。"
  },
  reads_writes: {
    label: relationLabel.reads_writes,
    color: "#fbbf24",
    accent: "读写数据",
    description: "源模块会读取或写入目标数据层、仓储、缓存、文件或数据库资源。"
  },
  external_api: {
    label: relationLabel.external_api,
    color: "#a78bfa",
    accent: "外部 API",
    description: "源模块会调用第三方服务、外部 HTTP API、SDK 或平台网关。"
  },
  publishes_event: {
    label: relationLabel.publishes_event,
    color: "#a3e635",
    accent: "发布事件",
    description: "源模块向事件总线、消息队列或领域事件通道发布消息。"
  },
  subscribes_event: {
    label: relationLabel.subscribes_event,
    color: "#22d3ee",
    accent: "订阅事件",
    description: "源模块订阅、消费或监听目标事件、队列消息或 webhook。"
  },
  tests: {
    label: relationLabel.tests,
    color: "#fb7185",
    accent: "测试覆盖",
    description: "源模块是测试面，覆盖目标模块的单元、集成、契约或端到端行为。"
  }
};

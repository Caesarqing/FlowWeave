import type {
  AgentHealthCheck,
  AgentHealthCheckResult,
  ToolAdapter as SharedToolAdapter,
  ToolDetectionResult,
  ToolId,
  ToolKind,
  ToolOpenResult,
  ToolRunEvent,
  ToolRunRequest,
  ToolRunResult,
  ToolRunStatus
} from "../../types";

export interface ToolAdapter extends SharedToolAdapter {}

export type {
  AgentHealthCheck,
  AgentHealthCheckResult,
  ToolDetectionResult,
  ToolId,
  ToolKind,
  ToolOpenResult,
  ToolRunEvent,
  ToolRunRequest,
  ToolRunResult,
  ToolRunStatus
};

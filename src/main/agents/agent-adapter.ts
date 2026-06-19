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

export type AgentId = ToolId;
export type AgentRunStatus = ToolRunStatus;
export type AgentRunEvent = ToolRunEvent;
export type AgentRunRequest = ToolRunRequest;
export type AgentRunResult = ToolRunResult;
export type AgentAdapter = ToolAdapter;

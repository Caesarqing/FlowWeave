import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentProtocolVersion,
  ArtifactRunTarget,
  ExecutionMode,
  RuntimeAgentId,
  ToolRunPurpose,
  ToolRunRequest,
  ToolRunResult,
  ToolRunStatus
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeJsonAtomic } from "../storage/artifact-store";

export const AGENT_INBOX_PROTOCOL_VERSION = 2 as AgentProtocolVersion;

export type AgentInboxRequest = {
  protocolVersion: AgentProtocolVersion;
  runId: string;
  projectId: string;
  agentId: RuntimeAgentId;
  projectPath: string;
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  reviewId?: string;
  prompt: string;
  responsePath: string;
  createdAt: string;
};

export type AgentInboxResponse = {
  protocolVersion: AgentProtocolVersion;
  runId: string;
  projectId: string;
  status: Extract<ToolRunStatus, "completed" | "failed">;
  summary: string;
  content: string;
  completedAt: string;
  error?: {
    code?: string;
    message: string;
  };
  sourcePath: string;
};

export function getAgentInboxRunDir(projectPath: string, runId: string): string {
  return join(projectPath, FLOWWEAVE_DIR, "runs", runId);
}

export function getAgentInboxRequestPath(projectPath: string, runId: string): string {
  return join(getAgentInboxRunDir(projectPath, runId), "agent-request.json");
}

export function getAgentInboxResponsePath(projectPath: string, runId: string): string {
  return join(getAgentInboxRunDir(projectPath, runId), "agent-response.json");
}

export async function writeAgentInboxRequest(request: ToolRunRequest, agentId: RuntimeAgentId): Promise<AgentInboxRequest> {
  const inboxRequest: AgentInboxRequest = {
    protocolVersion: AGENT_INBOX_PROTOCOL_VERSION,
    runId: request.id,
    projectId: request.projectId,
    agentId,
    projectPath: request.projectPath,
    executionMode: request.executionMode,
    purpose: request.purpose,
    artifactTarget: request.artifactTarget,
    scanFingerprint: request.scanFingerprint,
    reviewId: request.reviewId,
    prompt: request.prompt,
    responsePath: getAgentInboxResponsePath(request.projectPath, request.id),
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(getAgentInboxRequestPath(request.projectPath, request.id), inboxRequest);
  return inboxRequest;
}

export function buildAgentInboxInstruction(projectPath: string, runId: string): string {
  const requestPath = getAgentInboxRequestPath(projectPath, runId);
  const responsePath = getAgentInboxResponsePath(projectPath, runId);
  return [
    "Use the FlowWeave Agent Inbox protocol.",
    `Read the request JSON at: ${requestPath}`,
    `Write exactly one response JSON at: ${responsePath}`,
    "Do not return the final artifact only in stdout/chat.",
    "Do not edit FlowWeave review state files.",
    "For plan mode, inspect only; do not modify project source files.",
    "",
    "Required response shape:",
    "{ \"protocolVersion\": 2, \"runId\": string, \"projectId\": string, \"status\": \"completed\" | \"failed\", \"summary\": string, \"content\": string | object, \"completedAt\": ISO timestamp }"
  ].join("\n");
}

export async function readAgentInboxResponseForRun(
  projectPath: string,
  runId: string,
  result: Partial<ToolRunResult>
): Promise<AgentInboxResponse | undefined> {
  const responsePath = getAgentInboxResponsePath(projectPath, runId);
  const content = await readFile(responsePath, "utf8").catch(() => "");
  if (!content.trim()) return undefined;
  const response = parseAgentInboxResponse(content, responsePath);
  validateAgentInboxResponseForRun(response, { ...result, id: runId });
  return response;
}

export function parseAgentInboxResponse(content: string, sourcePath: string): AgentInboxResponse {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.protocolVersion !== AGENT_INBOX_PROTOCOL_VERSION) {
    throw new Error(`Agent inbox response protocolVersion must be ${AGENT_INBOX_PROTOCOL_VERSION} in ${sourcePath}.`);
  }
  const status = parsed.status;
  if (status !== "completed" && status !== "failed") {
    throw new Error(`Agent inbox response status must be "completed" or "failed" in ${sourcePath}.`);
  }
  const completedAt = requireInboxString(parsed.completedAt, "completedAt", sourcePath);
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error(`Agent inbox response completedAt is invalid in ${sourcePath}.`);
  }
  const contentText = normalizeResponseContent(parsed.content, sourcePath, status);
  const error = parseInboxError(parsed.error, sourcePath);
  return {
    protocolVersion: AGENT_INBOX_PROTOCOL_VERSION,
    runId: requireInboxString(parsed.runId, "runId", sourcePath),
    projectId: requireInboxString(parsed.projectId, "projectId", sourcePath),
    status,
    summary: requireInboxString(parsed.summary, "summary", sourcePath),
    content: contentText,
    completedAt,
    error,
    sourcePath
  };
}

export function validateAgentInboxResponseForRun(response: AgentInboxResponse, result: Partial<ToolRunResult>): void {
  requireMatchedInboxField("runId", result.id, response.runId);
  requireMatchedInboxField("projectId", result.projectId, response.projectId);
}

function normalizeResponseContent(
  value: unknown,
  sourcePath: string,
  status: Extract<ToolRunStatus, "completed" | "failed">
): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
  if (status === "failed") return "";
  throw new Error(`Agent inbox response content is required in ${sourcePath}.`);
}

function parseInboxError(value: unknown, sourcePath: string): AgentInboxResponse["error"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(`Agent inbox response error must be an object in ${sourcePath}.`);
  }
  const candidate = value as Record<string, unknown>;
  return {
    code: typeof candidate.code === "string" && candidate.code.trim() ? candidate.code : undefined,
    message: requireInboxString(candidate.message, "error.message", sourcePath)
  };
}

function requireInboxString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent inbox response ${field} is required in ${sourcePath}.`);
  }
  return value;
}

function requireMatchedInboxField(field: string, expected: string | undefined, received: string | undefined): void {
  if (expected === undefined) {
    throw new Error(`${field} cannot be validated because the FlowWeave run is missing its expected ${field}.`);
  }
  if (received === undefined) {
    throw new Error(`${field} is required for Agent Inbox protocol v${AGENT_INBOX_PROTOCOL_VERSION} response validation.`);
  }
  if (received !== expected) {
    throw new Error(`${field} mismatch: expected ${expected}, received ${received}.`);
  }
}

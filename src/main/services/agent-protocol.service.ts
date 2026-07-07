import type {
  AgentExpectedContentKind,
  AgentProtocolVersion,
  ArtifactRunTarget,
  ExecutionMode,
  ToolRunPurpose,
  ToolRunResult,
  ToolRunStatus
} from "../../types";

export const AGENT_PROTOCOL_VERSION: AgentProtocolVersion = 1;
export const FLOWWEAVE_PLUGIN_ID = "flowweave";

export type BridgeResponse = {
  protocolVersion?: AgentProtocolVersion;
  runId?: string;
  projectId?: string;
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  reviewId?: string;
  status: Extract<ToolRunStatus, "completed" | "failed">;
  summary: string;
  content: string;
  completedAt?: string;
  sourcePath: string;
  warnings: string[];
};

export function expectedContentKindForPurpose(purpose: ToolRunPurpose): AgentExpectedContentKind {
  return purpose === "artifact-analysis" ? "artifact-json" : "markdown-plan";
}

export function parseBridgeResponse(content: string, sourcePath: string): BridgeResponse {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const warnings: string[] = [];
  const isProtocolV1 = parsed.protocolVersion === AGENT_PROTOCOL_VERSION;
  if (parsed.protocolVersion === undefined) {
    warnings.push("Desktop bridge response is missing protocolVersion; treating it as legacy protocol v0.");
  } else if (!isProtocolV1) {
    throw new Error(`Desktop bridge response protocolVersion must be ${AGENT_PROTOCOL_VERSION} in ${sourcePath}.`);
  }
  if (parsed.status !== "completed" && parsed.status !== "failed") {
    throw new Error(`Desktop bridge response status must be "completed" or "failed" in ${sourcePath}.`);
  }
  if (isProtocolV1) {
    requireResponseString(parsed.runId, "runId", sourcePath);
    requireResponseString(parsed.projectId, "projectId", sourcePath);
    requireResponseString(parsed.summary, "summary", sourcePath);
    requireResponseString(parsed.completedAt, "completedAt", sourcePath);
  }
  const contentValue = typeof parsed.content === "string" ? parsed.content : "";
  if (!contentValue.trim()) {
    throw new Error(`Desktop bridge response content is required in ${sourcePath}.`);
  }
  if (parsed.artifactTarget !== undefined && !isArtifactRunTarget(parsed.artifactTarget)) {
    throw new Error(`Desktop bridge response artifactTarget is invalid in ${sourcePath}.`);
  }
  const completedAt = optionalString(parsed.completedAt);
  if (completedAt !== undefined && Number.isNaN(Date.parse(completedAt))) {
    throw new Error(`Desktop bridge response completedAt is invalid in ${sourcePath}.`);
  }
  return {
    protocolVersion: parsed.protocolVersion === AGENT_PROTOCOL_VERSION ? parsed.protocolVersion : undefined,
    runId: optionalString(parsed.runId),
    projectId: optionalString(parsed.projectId),
    artifactTarget: isArtifactRunTarget(parsed.artifactTarget) ? parsed.artifactTarget : undefined,
    scanFingerprint: optionalString(parsed.scanFingerprint),
    reviewId: optionalString(parsed.reviewId),
    status: parsed.status,
    summary: optionalString(parsed.summary)?.trim() || `${parsed.status} desktop bridge response.`,
    content: contentValue,
    completedAt,
    sourcePath,
    warnings
  };
}

export function validateBridgeResponseForRun(response: BridgeResponse, result: Partial<ToolRunResult>): void {
  if (response.protocolVersion === AGENT_PROTOCOL_VERSION) {
    requireMatchedResponseField("runId", result.id, response.runId);
    requireMatchedResponseField("projectId", result.projectId, response.projectId);
    if (result.purpose === "artifact-analysis") {
      requireMatchedResponseField("artifactTarget", result.artifactTarget, response.artifactTarget);
      requireMatchedResponseField("scanFingerprint", result.scanFingerprint, response.scanFingerprint);
      if (result.reviewId !== undefined) {
        requireMatchedResponseField("reviewId", result.reviewId, response.reviewId);
      }
    }
  }
  const checks: Array<[string, string | undefined, string | undefined]> = [
    ["runId", result.id, response.runId],
    ["projectId", result.projectId, response.projectId],
    ["artifactTarget", result.artifactTarget, response.artifactTarget],
    ["scanFingerprint", result.scanFingerprint, response.scanFingerprint],
    ["reviewId", result.reviewId, response.reviewId]
  ];
  for (const [field, expected, received] of checks) {
    if (received !== undefined && expected !== undefined && received !== expected) {
      throw new Error(`${field} mismatch: expected ${expected}, received ${received}.`);
    }
  }
}

export function buildDesktopBridgeResponseInstructions(purpose: ToolRunPurpose): string {
  if (purpose === "artifact-analysis") {
    return [
      "Artifact analysis requires response.json. Do not answer only in chat.",
      "",
      "Write response.json in this same directory with this shape:",
      "",
      "{ \"protocolVersion\": 1, \"runId\": string, \"projectId\": string, \"artifactTarget\": string, \"scanFingerprint\": string, \"reviewId\": string, \"status\": \"completed\" | \"failed\", \"summary\": string, \"content\": string, \"completedAt\": ISO timestamp }",
      "",
      "The content field must contain the exact structured artifact JSON requested by prompt.md. Markdown plans, approval summaries, response.md, and implementation-plan prose do not update FlowWeave artifact review state.",
      "Do not edit `.flowweave/architecture-review.json` or `.flowweave/sequence-review.json`; FlowWeave Core is the only review state writer."
    ].join("\n");
  }
  return [
    "Write one response file in the same directory:",
    "",
    "- response.json with { \"protocolVersion\": 1, \"runId\": string, \"projectId\": string, \"status\": \"completed\" | \"failed\", \"summary\": string, \"content\": string, \"completedAt\": ISO timestamp }",
    "- or response.md with the plan markdown",
    "",
    "Prefer response.json when possible."
  ].join("\n");
}

export function buildAgentProtocolContextInstructions(): string[] {
  return [
    "## Agent Protocol v1",
    "",
    "- FlowWeave CLI runs and Desktop Bridge runs are separate channels; do not write bridge responses for CLI runs.",
    "- Desktop Bridge requests live under `.flowweave/agent-bridge/<runId>/request.json` and must be answered at that request's `responsePath`.",
    "- For artifact-analysis requests, `response.json.content` must contain the exact structured architecture or sequence JSON requested by `promptPath`.",
    "- For implementation-plan requests, `response.json.content` may contain markdown plan text.",
    "- Do not edit `.flowweave/architecture-review.json` or `.flowweave/sequence-review.json`; FlowWeave Core validates and updates review state after response import.",
    ""
  ];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requireResponseString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Desktop bridge response ${field} is required in ${sourcePath}.`);
  }
  return value;
}

function requireMatchedResponseField(field: string, expected: string | undefined, received: string | undefined): void {
  if (expected === undefined) {
    throw new Error(`${field} cannot be validated because the FlowWeave run is missing its expected ${field}.`);
  }
  if (received === undefined) {
    throw new Error(`${field} is required for protocol v${AGENT_PROTOCOL_VERSION} response validation.`);
  }
  if (received !== expected) {
    throw new Error(`${field} mismatch: expected ${expected}, received ${received}.`);
  }
}

function isArtifactRunTarget(value: unknown): value is ArtifactRunTarget {
  return value === "architecture-map" || value === "sequence-diagrams" || value === "sequence-revision";
}

export type BridgeRequestMetadata = {
  protocolVersion: AgentProtocolVersion;
  expectedContentKind: AgentExpectedContentKind;
  pluginHint: string;
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
};

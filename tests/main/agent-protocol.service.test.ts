import { describe, expect, it } from "vitest";
import {
  parseBridgeResponse,
  validateBridgeResponseForRun
} from "../../src/main/services/agent-protocol.service";
import type { ToolRunResult } from "../../src/types";

describe("agent-protocol.service", () => {
  it("parses protocol v1 desktop bridge responses", () => {
    const response = parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      runId: "run-1",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: "{\"version\":1}",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json");

    expect(response).toMatchObject({
      protocolVersion: 1,
      runId: "run-1",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: "{\"version\":1}"
    });
  });

  it("accepts legacy bridge responses only when required content is present", () => {
    const response = parseBridgeResponse(JSON.stringify({
      runId: "run-legacy",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: "# Plan",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json");

    expect(response.protocolVersion).toBeUndefined();
    expect(response.warnings).toContain("Desktop bridge response is missing protocolVersion; treating it as legacy protocol v0.");
  });

  it("rejects bridge responses without content", () => {
    expect(() => parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      runId: "run-1",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json")).toThrow("content is required");
  });

  it("rejects protocol v1 responses without run identity fields", () => {
    expect(() => parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: "{}",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json")).toThrow("runId is required");

    expect(() => parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      runId: "run-1",
      status: "completed",
      summary: "done",
      content: "{}",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json")).toThrow("projectId is required");
  });

  it("rejects invalid artifact targets instead of ignoring them", () => {
    expect(() => parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      runId: "run-1",
      projectId: "project-1",
      artifactTarget: "wrong-target",
      status: "completed",
      summary: "done",
      content: "{}",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json")).toThrow("artifactTarget is invalid");
  });

  it("requires artifact-analysis identity fields for protocol v1 validation", () => {
    const result: Partial<ToolRunResult> = {
      id: "run-expected",
      projectId: "project-expected",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-expected",
      reviewId: "review-expected"
    };
    const response = parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      runId: "run-expected",
      projectId: "project-expected",
      status: "completed",
      summary: "done",
      content: "{}",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json");

    expect(() => validateBridgeResponseForRun(response, result)).toThrow(
      "artifactTarget is required for protocol v1 response validation"
    );
  });

  it("reports run field mismatches before adoption", () => {
    const result: Partial<ToolRunResult> = {
      id: "run-expected",
      projectId: "project-expected",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-expected",
      reviewId: "review-expected"
    };
    const response = parseBridgeResponse(JSON.stringify({
      protocolVersion: 1,
      runId: "run-other",
      projectId: "project-other",
      artifactTarget: "sequence-diagrams",
      scanFingerprint: "scan-other",
      reviewId: "review-other",
      status: "completed",
      summary: "done",
      content: "{}",
      completedAt: "2026-07-01T00:00:00.000Z"
    }), "/tmp/response.json");

    expect(() => validateBridgeResponseForRun(response, result)).toThrow(
      "runId mismatch: expected run-expected, received run-other"
    );
  });
});

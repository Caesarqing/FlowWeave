import { describe, expect, it } from "vitest";
import { extractStructuredJson } from "../../src/main/services/structured-output.service";
import * as structuredOutput from "../../src/main/services/structured-output.service";

describe("structured-output.service", () => {
  it("extracts JSON from plain, fenced, and provider-wrapped output", () => {
    expect(extractStructuredJson('{"modules":[{"id":"api"}]}')).toMatchObject({
      value: { modules: [{ id: "api" }] }
    });
    expect(extractStructuredJson('```json\n{"modules":[]}\n```')).toMatchObject({
      value: { modules: [] }
    });
    expect(extractStructuredJson(JSON.stringify({
      type: "result",
      result: '{"modules":[{"id":"wrapped"}]}'
    }))).toMatchObject({
      value: { modules: [{ id: "wrapped" }] }
    });
  });

  it("selects a valid nested object without greedily joining multiple objects", () => {
    expect(extractStructuredJson('preface {"status":"ignore"} trailing {"modules":[{"id":"api"}]}', "modules"))
      .toMatchObject({ value: { modules: [{ id: "api" }] } });
  });

  it("requires every key when a structured response declares a key set", () => {
    expect(extractStructuredJson('{"modules":[],"findings":[]}', ["modules", "findings"]))
      .toMatchObject({ value: { modules: [], findings: [] } });
    expect(extractStructuredJson('{"modules":[]}', ["modules", "findings"]))
      .toMatchObject({ error: "missing-json" });
  });

  it("distinguishes missing and malformed JSON", () => {
    expect(extractStructuredJson("plain text")).toMatchObject({ error: "missing-json" });
    expect(extractStructuredJson('{"modules":[')).toMatchObject({ error: "malformed-json" });
  });

  it("strictly parses stable-ID review enhancements and evidence-backed findings", () => {
    const parsed = parseReview(validReviewResponse());

    expect(parsed).toMatchObject({
      architectureStyle: "layered service",
      modules: [{ moduleId: "api", title: "Reviewed API" }],
      findings: [{ code: "missing-boundary", moduleIds: ["api"], evidenceIds: ["evidence-api"] }]
    });
  });

  it("returns explicit errors for unknown and duplicate module IDs", () => {
    expect(() => parseReview({
      architectureStyle: "layered service",
      modules: [{ moduleId: "unknown", title: "Unknown" }],
      findings: []
    })).toThrow("Unknown moduleId");

    expect(() => parseReview({
      modules: [{ moduleId: "api", title: "First" }, { moduleId: "api", role: "Duplicate" }],
      findings: []
    })).toThrow("Duplicate moduleId");
  });

  it("rejects findings with unknown or unrelated evidence and rejects topology fields", () => {
    expect(() => parseReview({
      modules: [],
      findings: [{ code: "finding", severity: "warning", moduleIds: ["api"], message: "Problem", evidenceIds: ["missing"] }]
    })).toThrow("Invalid finding evidence");

    expect(() => parseReview({
      modules: [],
      findings: [],
      relationships: []
    })).toThrow("Unsupported architecture review field");
  });
});

function parseReview(value: unknown) {
  const parser = (structuredOutput as unknown as {
    parseArchitectureReviewResponse?: (
      output: string,
      context: { moduleIds: string[]; evidence: Array<{ id: string; moduleIds: string[] }> }
    ) => unknown;
  }).parseArchitectureReviewResponse;
  expect(parser).toBeTypeOf("function");
  if (!parser) throw new Error("Architecture review parser is unavailable.");
  return parser(JSON.stringify(value), {
    moduleIds: ["api", "service"],
    evidence: [
      { id: "evidence-api", moduleIds: ["api"] },
      { id: "evidence-service", moduleIds: ["service"] }
    ]
  });
}

function validReviewResponse() {
  return {
    architectureStyle: "layered service",
    modules: [{ moduleId: "api", title: "Reviewed API" }],
    findings: [{
      code: "missing-boundary",
      severity: "warning",
      moduleIds: ["api"],
      message: "The API boundary lacks explicit validation.",
      evidenceIds: ["evidence-api"]
    }]
  };
}

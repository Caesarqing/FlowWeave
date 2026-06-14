import { describe, expect, it } from "vitest";
import { extractStructuredJson } from "../../src/main/services/structured-output.service";

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

  it("distinguishes missing and malformed JSON", () => {
    expect(extractStructuredJson("plain text")).toMatchObject({ error: "missing-json" });
    expect(extractStructuredJson('{"modules":[')).toMatchObject({ error: "malformed-json" });
  });
});

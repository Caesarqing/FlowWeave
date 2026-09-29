import { describe, expect, it } from "vitest";
import { buildCrossStackHttpRelations } from "../../src/main/services/cross-stack-relation.service";
import type { SemanticHttpEndpoint } from "../../src/types";

describe("cross-stack-relation.service", () => {
  it("matches frontend requests to backend routes by proven service identity, method and normalized path", () => {
    const endpoints: SemanticHttpEndpoint[] = [
      endpoint("request", "src/api.ts", "GET", "/api/users/${id}"),
      endpoint("route", "server/users.ts", "GET", "/api/users/:id")
    ];

    expect(buildCrossStackHttpRelations(endpoints)).toEqual([
      expect.objectContaining({
        kind: "http",
        sourceFile: "src/api.ts",
        targetFile: "server/users.ts",
        confidence: "confirmed"
      })
    ]);
  });

  it("does not link equal paths across different or unproven services", () => {
    const request = endpoint("request", "client.ts", "GET", "/users");
    const route = endpoint("route", "server.ts", "GET", "/users");
    expect(buildCrossStackHttpRelations([{ ...request, serviceId: "service:other" }, route])).toEqual([]);
    expect(buildCrossStackHttpRelations([{ ...request, serviceId: undefined }, { ...route, serviceId: undefined }])).toEqual([]);
    expect(buildCrossStackHttpRelations([request, route, { ...route, id: "duplicate", filePath: "duplicate.ts" }])).toEqual([]);
  });

  it("does not match routes with different methods", () => {
    const endpoints: SemanticHttpEndpoint[] = [
      endpoint("request", "src/api.ts", "POST", "/api/users/1"),
      endpoint("route", "server/users.ts", "GET", "/api/users/:id")
    ];

    expect(buildCrossStackHttpRelations(endpoints)).toEqual([]);
  });
});

function endpoint(
  kind: SemanticHttpEndpoint["kind"],
  filePath: string,
  method: SemanticHttpEndpoint["method"],
  path: string
): SemanticHttpEndpoint {
  return {
    id: `${kind}-${filePath}`,
    kind,
    filePath,
    method,
    path,
    normalizedPath: "",
    serviceId: "service:users",
    confidence: "confirmed"
  };
}

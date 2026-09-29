import { expect, it } from "vitest";
import { buildResourceRelations } from "../../src/main/services/semantic-resource.service";
import type { SemanticOperationFact } from "../../src/types";

it("retains operation sites and scopes event identities without leaking URL credentials", () => {
  const facts: SemanticOperationFact[] = [
    operation("http", "https://user:password@example.test/api/users?token=private", "invoke", "ui"),
    { ...operation("event", "changed", "publish", "app"), receiverId: "emitter:a" },
    { ...operation("event", "changed", "subscribe", "app"), receiverId: "emitter:b" },
    operation("filesystem", undefined, "read", "app")
  ];
  const result = buildResourceRelations(facts, []);
  expect(result.resources.filter((resource) => resource.kind === "event")).toHaveLength(2);
  expect(result.resources.find((resource) => resource.kind === "api")?.title).toBe("GET https://example.test/api/users");
  expect(JSON.stringify(result)).not.toMatch(/password|private|user:/);
  expect(result.relations).toHaveLength(4);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "resource-target-unresolved", filePath: "app/source.ts" }));
  expect(facts[0].target).toContain("password");
});

function operation(kind: SemanticOperationFact["kind"], target: string | undefined, action: SemanticOperationFact["operation"], scopeId: string): SemanticOperationFact {
  return { kind, target, operation: action, scopeId, filePath: `${scopeId}/source.ts`, moduleName: "verified-api", apiName: "operation", method: "GET", confidence: "confirmed", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 12 } } };
}

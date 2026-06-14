import { describe, expect, it } from "vitest";
import { analyzeSourceFile } from "../../src/main/services/language-analyzer.service";

describe("language-analyzer.service", () => {
  it("extracts Vue script imports, components, and template renders", async () => {
    const result = await analyzeSourceFile("src/UserPage.vue", `
<script setup lang="ts">
import UserCard from './UserCard.vue'
const loadUser = async (id: string) => fetch(\`/api/users/\${id}\`)
</script>
<template><UserCard /></template>
`, []);

    expect(result.analyzerId).toBe("vue-compiler-sfc");
    expect(result.analysisDepth).toBe("semantic");
    expect(result.insight.imports).toContain("./UserCard.vue");
    expect(result.insight.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "loadUser", kind: "function" })
    ]));
    expect(result.renderTargets).toContain("UserCard");
  });

  it.each([
    ["app/service.py", "class PaymentService:\n  pass\n\ndef sync_payment(order_id: str):\n  return order_id\n", "PaymentService", "sync_payment"],
    ["src/PaymentService.java", "public class PaymentService { public String syncPayment(String id) { return id; } }", "PaymentService", "syncPayment"],
    ["service/payment.go", "type PaymentService struct {}\nfunc (s *PaymentService) SyncPayment(id string) string { return id }\n", "PaymentService", "SyncPayment"]
  ])("extracts symbols from %s", async (path, source, className, functionName) => {
    const result = await analyzeSourceFile(path, source, []);

    expect(result.analyzerId).toContain("tree-sitter-wasm");
    expect(result.analysisDepth).toBe("semantic");
    expect(result.insight.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: className }),
      expect.objectContaining({ name: functionName })
    ]));
  });
});

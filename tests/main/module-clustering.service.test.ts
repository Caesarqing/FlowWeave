import { describe, expect, it } from "vitest";
import { clusterArchitectureModules } from "../../src/main/services/module-clustering.service";
import type { ArchitectureModule, FileInsight, SemanticRelation } from "../../src/types";
import { moduleClusteringFixture } from "./graph.fixture";

describe("module-clustering.service", () => {
  it("keeps cohesive feature files together and prefers a stable boundary-file anchor", () => {
    const result = clusterArchitectureModules(
      moduleClusteringFixture.files,
      moduleClusteringFixture.relations,
      []
    );
    const billing = result.modules.find((module) => module.files.includes("src/features/billing/billing.service.ts"));

    expect(billing).toBeDefined();
    expect(billing?.files).toEqual(expect.arrayContaining([
      "src/features/billing/BillingPanel.tsx",
      "src/features/billing/billing.ipc.ts",
      "src/features/billing/storage/invoice.repository.ts",
      "src/main/services/billing-format.ts"
    ]));
    expect(billing?.identity.anchor).toBe("file:src/features/billing/billing.ipc.ts");
    expect(billing?.identity.id).toBe(billing?.id);
  });

  it("produces identical module IDs and file ownership for repeated inputs", () => {
    const first = clusterArchitectureModules(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const second = clusterArchitectureModules(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);

    expect(second).toEqual(first);
  });

  it("keeps distinct normalized anchor paths distinct even when their slug forms collide", () => {
    const result = clusterArchitectureModules([
      fileInsight("src/user-management/user.controller.ts"),
      fileInsight("src/user/management-user.controller.ts")
    ], [], []);

    expect(result.modules).toHaveLength(2);
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
    expect(new Set(result.modules.map((module) => module.identity.anchor)).size).toBe(2);
  });

  it("preserves boundary categories from filename suffixes", () => {
    const result = clusterArchitectureModules([
      fileInsight("src/notifications/email.worker.ts"),
      fileInsight("src/billing/invoice.repository.ts"),
      fileInsight("src/orders/orders.controller.ts"),
      fileInsight("src/payments/payment.ipc.ts")
    ], [], []);

    expect(moduleForFile(result.modules, "src/notifications/email.worker.ts")?.category).toBe("job-worker");
    expect(moduleForFile(result.modules, "src/billing/invoice.repository.ts")?.category).toBe("data-access");
    expect(moduleForFile(result.modules, "src/orders/orders.controller.ts")?.category).toBe("api-boundary");
    expect(moduleForFile(result.modules, "src/payments/payment.ipc.ts")?.category).toBe("api-boundary");
  });

  it("classifies support code as shared only when three distinct functional domains reference it", () => {
    const sameDomainReference = {
      ...moduleClusteringFixture.relations[0],
      id: "billing-panel-date",
      source: "src/features/billing/BillingPanel.tsx",
      sourceFile: "src/features/billing/BillingPanel.tsx"
    };
    const twoDomainRelations = [
      ...moduleClusteringFixture.relations.filter((relation) => relation.id !== "notifications-date"),
      sameDomainReference
    ];
    const underThreshold = clusterArchitectureModules(moduleClusteringFixture.files, twoDomainRelations, []);
    const eligible = clusterArchitectureModules(
      moduleClusteringFixture.files,
      moduleClusteringFixture.relations,
      []
    );

    expect(moduleForFile(underThreshold.modules, "src/shared/date.util.ts")?.category).not.toBe("shared-utility");
    expect(moduleForFile(eligible.modules, "src/shared/date.util.ts")?.category).toBe("shared-utility");
  });

  it("evaluates the shared threshold independently for each support file", () => {
    const files = [
      fileInsight("src/features/billing/billing.service.ts"),
      fileInsight("src/features/identity/identity.service.ts"),
      fileInsight("src/features/notifications/notifications.service.ts"),
      fileInsight("src/shared/date.util.ts"),
      fileInsight("src/common/date.util.ts")
    ];
    const relations = [
      relation("billing-shared-date", "src/features/billing/billing.service.ts", "src/shared/date.util.ts"),
      relation("identity-shared-date", "src/features/identity/identity.service.ts", "src/shared/date.util.ts"),
      relation("notifications-common-date", "src/features/notifications/notifications.service.ts", "src/common/date.util.ts")
    ];
    const result = clusterArchitectureModules(files, relations, []);

    expect(moduleForFile(result.modules, "src/shared/date.util.ts")?.category).not.toBe("shared-utility");
    expect(moduleForFile(result.modules, "src/common/date.util.ts")?.category).not.toBe("shared-utility");
  });

  it("does not classify a specifically named service as shared even when many domains call it", () => {
    const service = fileInsight("src/shared/security.service.ts");
    const relations = [
      ...moduleClusteringFixture.relations,
      ...["billing", "identity", "notifications"].map((domain) => ({
        id: `${domain}-security`,
        kind: "call" as const,
        source: `src/features/${domain}/${domain}.service.ts`,
        target: service.path,
        sourceFile: `src/features/${domain}/${domain}.service.ts`,
        targetFile: service.path,
        detail: `${domain} calls security service`,
        confidence: "confirmed" as const
      }))
    ];
    const result = clusterArchitectureModules([...moduleClusteringFixture.files, service], relations, []);

    expect(moduleForFile(result.modules, service.path)?.category).toBe("domain-service");
  });

  it("keeps the ID when ordinary files are added under the same anchor and updates the fingerprint", () => {
    const initial = clusterArchitectureModules(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const previousModules = initial.modules.map(toArchitectureModule);
    const updated = clusterArchitectureModules(
      [...moduleClusteringFixture.files, fileInsight("src/features/billing/receipt.presenter.ts")],
      moduleClusteringFixture.relations,
      previousModules
    );
    const before = moduleForFile(initial.modules, "src/features/billing/billing.service.ts");
    const after = moduleForFile(updated.modules, "src/features/billing/billing.service.ts");

    expect(after?.id).toBe(before?.id);
    expect(after?.identity.anchor).toBe(before?.identity.anchor);
    expect(after?.identity.clusterFingerprint).not.toBe(before?.identity.clusterFingerprint);
  });

  it("records predecessor lineage for module splits and merges", () => {
    const initial = clusterArchitectureModules(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const billing = moduleForFile(initial.modules, "src/features/billing/billing.service.ts");
    if (!billing) throw new Error("Expected a billing module in the fixture.");
    const splitParent = toArchitectureModule({
      ...billing,
      files: ["src/features/billing/billing.service.ts", "src/features/identity/identity.service.ts"]
    });
    const split = clusterArchitectureModules(moduleClusteringFixture.files, moduleClusteringFixture.relations, [splitParent]);
    const identityAfterSplit = moduleForFile(split.modules, "src/features/identity/identity.service.ts");

    expect(identityAfterSplit?.identity.predecessorIds).toContain(splitParent.id);
    expect(split.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "lineage-split", moduleIds: expect.arrayContaining([billing.id]) })
    ]));

    const billingUiParent = toArchitectureModule({
      ...billing,
      id: "legacy-billing-ui",
      identity: { ...billing.identity, id: "legacy-billing-ui", anchor: "file:legacy/billing-ui.ts" },
      files: ["src/features/billing/BillingPanel.tsx", "src/features/billing/billing.ipc.ts"]
    });
    const billingServiceParent = toArchitectureModule({
      ...billing,
      id: "legacy-billing-service",
      identity: { ...billing.identity, id: "legacy-billing-service", anchor: "file:legacy/billing-service.ts" },
      files: ["src/features/billing/billing.service.ts", "src/features/billing/storage/invoice.repository.ts"]
    });
    const merged = clusterArchitectureModules(
      moduleClusteringFixture.files,
      moduleClusteringFixture.relations,
      [billingUiParent, billingServiceParent]
    );
    const mergedBilling = moduleForFile(merged.modules, "src/features/billing/billing.service.ts");

    expect(mergedBilling?.identity.predecessorIds).toEqual(["legacy-billing-service", "legacy-billing-ui"]);
    expect(merged.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "lineage-merge", moduleIds: [mergedBilling?.id] })
    ]));
  });

  it("records every predecessor when a merge keeps one predecessor's ID", () => {
    const initial = clusterArchitectureModules([
      fileInsight("src/main/billing.service.ts"),
      fileInsight("src/main/identity.service.ts")
    ], [], []);
    const previousModules = initial.modules.map(toArchitectureModule);
    const billingParent = moduleForFile(initial.modules, "src/main/billing.service.ts");
    const identityParent = moduleForFile(initial.modules, "src/main/identity.service.ts");
    if (!billingParent || !identityParent) throw new Error("Expected separate billing and identity modules.");
    const merged = clusterArchitectureModules([
      fileInsight("src/main/billing.service.ts"),
      fileInsight("src/main/billing.store.ts"),
      fileInsight("src/main/identity.service.ts")
    ], [relation("billing-calls-identity", "src/main/billing.service.ts", "src/main/identity.service.ts")], previousModules);
    const mergedBilling = moduleForFile(merged.modules, "src/main/billing.service.ts");

    expect(mergedBilling?.id).toBe(billingParent.id);
    expect(mergedBilling?.identity.predecessorIds).toEqual([billingParent.id, identityParent.id].sort());
  });

  it("merges a non-boundary singleton into its strongest confirmed neighbor", () => {
    const ui = "src/features/billing/BillingPanel.tsx";
    const service = "src/main/invoice.service.ts";
    const result = clusterArchitectureModules(
      [fileInsight(ui), fileInsight(service)],
      [relation("billing-panel-invoice", ui, service)],
      []
    );

    expect(moduleForFile(result.modules, ui)?.files).toEqual([ui, service]);
  });

  it("keeps unclassified and oversized modules visible through diagnostics", () => {
    const oversizedFiles = Array.from({ length: 21 }, (_, index) =>
      fileInsight(`src/features/archive/archive-${index}.service.ts`)
    );
    const result = clusterArchitectureModules(
      [...moduleClusteringFixture.files, fileInsight("src/index.ts"), ...oversizedFiles],
      moduleClusteringFixture.relations,
      []
    );

    expect(moduleForFile(result.modules, "src/index.ts")).toMatchObject({ title: "Unknown", category: "unknown" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown-files", filePaths: ["src/index.ts"] }),
      expect.objectContaining({ code: "oversized-module", filePaths: expect.arrayContaining(oversizedFiles.map((file) => file.path)) })
    ]));
  });

  it("groups unknown files by their stable directory anchor", () => {
    const initial = clusterArchitectureModules(
      [fileInsight("src/index.ts"), fileInsight("src/app.ts")],
      [],
      []
    );
    const previousModules = initial.modules.map(toArchitectureModule);
    const updated = clusterArchitectureModules(
      [fileInsight("src/index.ts"), fileInsight("src/app.ts"), fileInsight("src/main.ts")],
      [],
      previousModules
    );

    expect(initial.modules).toHaveLength(1);
    expect(updated.modules).toHaveLength(1);
    expect(updated.modules[0].id).toBe(initial.modules[0].id);
    expect(updated.modules[0].identity.clusterFingerprint).not.toBe(initial.modules[0].identity.clusterFingerprint);
  });
});

function moduleForFile<T extends { files: string[] }>(modules: T[], file: string): T | undefined {
  return modules.find((module) => module.files.includes(file));
}

function fileInsight(path: string): FileInsight {
  return { path, imports: [], exports: [], symbols: [], calls: [], externalCalls: [] };
}

function relation(id: string, sourceFile: string, targetFile: string): SemanticRelation {
  return {
    id,
    kind: "call",
    source: sourceFile,
    target: targetFile,
    sourceFile,
    targetFile,
    detail: `${sourceFile} calls ${targetFile}`,
    confidence: "confirmed"
  };
}

function toArchitectureModule(module: {
  id: string;
  title: string;
  category: ArchitectureModule["category"];
  files: string[];
  identity: ArchitectureModule["identity"];
}): ArchitectureModule {
  if (!module.identity) throw new Error(`Missing identity for ${module.id}.`);
  const nodeTypes: Record<ArchitectureModule["category"], ArchitectureModule["nodeType"]> = {
    "api-boundary": "api",
    "domain-service": "service",
    "data-access": "data",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "test",
    "unknown": "module"
  };
  return {
    id: module.id,
    title: module.title,
    category: module.category,
    nodeType: nodeTypes[module.category],
    identity: module.identity,
    role: "Fixture role.",
    description: "Fixture module.",
    files: module.files,
    fileRoles: [],
    symbols: [],
    evidence: [],
    risk: "unknown"
  };
}

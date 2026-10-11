import { describe, expect, it } from "vitest";
import { clusterArchitectureModules } from "../../src/main/services/module-clustering.service";
import type { AnalysisScope, ArchitectureModule, FileInsight, SemanticRelation } from "../../src/types";
import { moduleClusteringFixture } from "./graph.fixture";

describe("module-clustering.service", () => {
  it("classifies Go _test.go files as test surfaces", () => {
    const result = clusterWithoutScopes(["mux.go", "mux_test.go", "path_value_test.go"].map(fileInsight), [], []);
    expect(moduleForFile(result.modules, "mux.go")?.category).not.toBe("test-surface");
    expect(moduleForFile(result.modules, "mux_test.go")?.category).toBe("test-surface");
    expect(moduleForFile(result.modules, "path_value_test.go")?.category).toBe("test-surface");
  });

  it("distinguishes generic controller directories by their owning service", () => {
    const paths = [
      "backend/services/search-service/controllers/search.controller.js",
      "backend/services/user-service/controllers/user.controller.js",
      "backend/services/news-service/controllers/news.controller.js"
    ];
    const result = clusterWithoutScopes(paths.map(fileInsight), [], []);
    expect(result.modules.map((module) => module.title).sort()).toEqual([
      "Controllers · News Service", "Controllers · Search Service", "Controllers · User Service"
    ]);
  });

  it("uses complete service, page, and shared directory boundaries in a mixed application", () => {
    const paths = [
      "backend/services/news-service/app.js", "backend/services/news-service/routes/news.routes.js",
      "backend/services/news-service/models/News.js", "backend/services/news_scraper/app.py",
      "backend/services/news_scraper/service.py", "backend/services/news_scraper/__init__.py",
      "frontend/src/pages/auth/Login.tsx", "frontend/src/pages/auth/Register.tsx",
      "frontend/src/shared/ui/button.tsx", "frontend/src/shared/ui/utils.ts",
      "frontend/src/shared/i18n/index.ts", "frontend/src/shared/i18n/messages/en.ts"
    ];
    const result = clusterWithoutScopes(paths.map(fileInsight), [], []);
    expect(moduleForFile(result.modules, paths[0])?.files).toEqual(paths.slice(0, 3).sort());
    expect(moduleForFile(result.modules, paths[3])?.files).toEqual(paths.slice(3, 6).sort());
    expect(moduleForFile(result.modules, paths[6])?.files).toEqual(paths.slice(6, 8).sort());
    expect(moduleForFile(result.modules, paths[8])).toMatchObject({ title: "Shared Ui", category: "shared-utility", files: paths.slice(8, 10).sort() });
    expect(moduleForFile(result.modules, paths[10])).toMatchObject({ title: "Shared I18n", category: "shared-utility" });
    expect(result.modules.some((module) => module.title === "Unknown" || module.title === "Init")).toBe(false);
  });

  it("does not absorb a named server responsibility just because one client calls it", () => {
    const client = "client/UserPage.tsx";
    const server = "server/users.ts";
    const result = clusterWithoutScopes([client, server].map(fileInsight), [relation("load-user", client, server)], []);
    expect(result.modules).toHaveLength(2);
    expect(moduleForFile(result.modules, server)?.files).toEqual([server]);
  });

  it("does not merge same-named files from unrelated API and storage areas", () => {
    const paths = ["src/api/user.ts", "src/storage/user.ts"];
    const result = clusterWithoutScopes(paths.map(fileInsight), [], []);

    expect(result.modules).toHaveLength(2);
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
    expect(new Set(result.modules.map((module) => module.title)).size).toBe(2);
    expect(result.modules.map((module) => module.title).sort()).toEqual(["User · Api", "User · Storage"]);
    expect(moduleForFile(result.modules, paths[0])?.files).toEqual([paths[0]]);
    expect(moduleForFile(result.modules, paths[1])?.files).toEqual([paths[1]]);
  });

  it("keeps same-named features in different applications separate", () => {
    const paths = ["apps/admin/src/features/news/index.ts", "apps/public/src/features/news/index.ts"];
    const scopes = [
      analysisScope("admin", "apps/admin", [paths[0]]),
      analysisScope("public", "apps/public", [paths[1]])
    ];
    const result = clusterArchitectureModules(paths.map(fileInsight), [], [], scopes);
    expect(result.modules).toHaveLength(2);
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
  });

  it("keeps same-path responsibilities in distinct language scopes at one package root", () => {
    const paths = [
      "apps/demo/src/features/payments/payments.service.ts",
      "apps/demo/src/features/payments/payments.service.java"
    ];
    const scopes: AnalysisScope[] = [
      {
        id: "typescript:apps/demo", language: "typescript", rootPath: "apps/demo",
        sourceRoots: ["apps/demo/src"], paths: [paths[0]], configurationPaths: []
      },
      {
        id: "java:apps/demo", language: "java", rootPath: "apps/demo",
        sourceRoots: ["apps/demo/src"], paths: [paths[1]], configurationPaths: []
      }
    ];

    const result = clusterArchitectureModules(paths.map(fileInsight), [], [], scopes);

    expect(result.modules).toHaveLength(2);
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
    expect(result.modules.every((module) => module.files.length === 1)).toBe(true);
    expect(result.modules.flatMap((module) => module.files).sort()).toEqual(paths.sort());
  });

  it("gives test modules under separate functional directories distinct identities", () => {
    const paths = [
      "src/features/payments/__tests__/payment.spec.ts",
      "src/features/orders/__tests__/order.spec.ts"
    ];

    const result = clusterWithoutScopes(paths.map(fileInsight), [], []);

    expect(result.modules).toHaveLength(2);
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
    expect(result.modules.map((module) => module.identity.anchor).sort()).toEqual([
      "tests:src/features/orders",
      "tests:src/features/payments"
    ]);
  });

  it("keeps nested test surfaces distinct from their owning production module", () => {
    const paths = [
      "luigi/static/visualiser/js/graph.js",
      "luigi/static/visualiser/js/test/graph_test.js"
    ];
    const scopes = [analysisScope("typescript:.", "", paths)];
    const result = clusterArchitectureModules(paths.map(fileInsight), [], [], scopes);
    const production = moduleForFile(result.modules, paths[0]);
    const tests = moduleForFile(result.modules, paths[1]);

    expect(result.modules).toHaveLength(2);
    expect(tests?.category).toBe("test-surface");
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
    expect(tests?.identity.anchor).not.toBe(production?.identity.anchor);

    const expandedPaths = [...paths, "luigi/static/visualiser/js/test/util_test.js"];
    const reopened = clusterArchitectureModules(expandedPaths.map(fileInsight), [], result.modules.map(toArchitectureModule), [
      analysisScope("typescript:.", "", expandedPaths)
    ]);
    expect(moduleForFile(reopened.modules, paths[0])?.id).toBe(production?.id);
    expect(moduleForFile(reopened.modules, paths[1])?.id).toBe(tests?.id);
    expect(moduleForFile(reopened.modules, paths[1])?.files).toEqual(expandedPaths.slice(1).sort());
  });

  it("does not treat a generic lib directory as one functional module", () => {
    const paths = [
      "src/lib/api-client.ts",
      "src/lib/date.ts",
      "src/lib/logger.ts"
    ];

    const result = clusterWithoutScopes(paths.map(fileInsight), [], []);

    expect(result.modules.map((module) => module.title).sort()).toEqual(["Api Client", "Date", "Logger"]);
    expect(result.modules.every((module) => module.identity.anchor !== "directory:src/lib")).toBe(true);
  });

  it("keeps shared contracts outside their callers and scopes filename responsibilities to each application", () => {
    const paths = ["frontend/src/app/App.tsx", "frontend/src/types/api.ts", "packages/contracts/src/api-paths.ts",
      "frontend/src/utils/formatter.ts", "backend/utils/formatter.ts"];
    const scopes = [
      analysisScope("frontend", "frontend", [paths[0], paths[1], paths[3]]),
      analysisScope("contracts", "packages/contracts", [paths[2]]),
      analysisScope("backend", "backend", [paths[4]])
    ];
    const result = clusterArchitectureModules(paths.map(fileInsight), [
      relation("contract-call", paths[0], paths[2])
    ], [], scopes);
    expect(moduleForFile(result.modules, paths[1])).toMatchObject({ title: "Shared Contracts", category: "shared-utility", files: [paths[1]] });
    expect(moduleForFile(result.modules, paths[2])).toMatchObject({ title: "Shared Contracts", category: "shared-utility", files: [paths[2]] });
    expect(moduleForFile(result.modules, paths[0])?.files).not.toContain(paths[2]);
    expect(moduleForFile(result.modules, paths[3])?.id).not.toBe(moduleForFile(result.modules, paths[4])?.id);
  });
  it("groups named helpers only when confirmed calls support a shared responsibility", () => {
    const workspace = "src/utils/workspace.tsx";
    const layout = "src/utils/workspace-layout.ts";
    const filters = "src/utils/workspace-filters.ts";
    const unrelated = "src/utils/graph-converters.ts";
    const result = clusterWithoutScopes(
      [workspace, layout, filters, unrelated].map(fileInsight),
      [relation("canvas-layout", workspace, layout), relation("canvas-filters", workspace, filters)],
      []
    );

    expect(moduleForFile(result.modules, workspace)?.files).toEqual([workspace, filters, layout].sort());
    expect(moduleForFile(result.modules, unrelated)).toMatchObject({ title: "Graph Converters" });
    expect(result.modules.some((module) => module.title === "Unknown")).toBe(false);
  });

  it("uses generic contract directories without special-casing entrypoint filenames", () => {
    const result = clusterWithoutScopes([
      "src/App.tsx", "src/main.tsx", "src/main/index.ts", "src/types.ts", "src/common/ipc-channels.ts"
    ].map(fileInsight), [], []);

    expect(moduleForFile(result.modules, "src/types.ts")).toMatchObject({
      title: "Shared Contracts",
      category: "shared-utility"
    });
    expect(moduleForFile(result.modules, "src/common/ipc-channels.ts")?.id)
      .not.toBe(moduleForFile(result.modules, "src/types.ts")?.id);
    expect(result.modules.map((module) => module.title)).not.toContain("Application Shell");
    expect(result.modules.map((module) => module.title)).not.toContain("Main Entry");
  });

  it("does not group modules using FlowWeave-specific component, Agent, or IPC paths", () => {
    const result = clusterWithoutScopes([
      "src/ui/NodeRenderer.tsx",
      "src/agents/cloud.adapter.ts",
      "src/agents/local.adapter.ts",
      "src/messaging/ipc-project.ts",
      "src/messaging/ipc-workspace.ts"
    ].map(fileInsight), [], []);

    for (const path of [
      "src/ui/NodeRenderer.tsx",
      "src/agents/cloud.adapter.ts",
      "src/agents/local.adapter.ts",
      "src/messaging/ipc-project.ts",
      "src/messaging/ipc-workspace.ts"
    ]) expect(moduleForFile(result.modules, path)?.files).toEqual([path]);
    expect(moduleForFile(result.modules, "src/agents/cloud.adapter.ts")?.title).toBe("Cloud");
    expect(moduleForFile(result.modules, "src/agents/local.adapter.ts")?.title).toBe("Local");
  });

  it("keeps a singleton independent when confirmed callers tie across responsibilities", () => {
    const helper = "src/services/formatter.service.ts";
    const billing = "src/features/billing/billing.service.ts";
    const orders = "src/features/orders/order.service.ts";
    const result = clusterWithoutScopes(
      [helper, billing, orders].map(fileInsight),
      [relation("billing-formatter", billing, helper), relation("orders-formatter", orders, helper)],
      []
    );

    expect(moduleForFile(result.modules, helper)?.files).toEqual([helper]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "ambiguous-ownership",
      filePaths: [helper]
    }));
  });

  it("reports conflicting API and data-access role signals without splitting a source file", () => {
    const path = "src/features/orders/order.repository.controller.ts";
    const result = clusterWithoutScopes([fileInsight(path)], [], []);

    expect(result.modules.flatMap((module) => module.files).filter((file) => file === path)).toEqual([path]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "mixed-role-signals",
      filePaths: [path],
      roleSignals: ["api-boundary", "data-access"]
    }));
  });

  it("keeps a generic utility entry honestly unknown when no responsibility is evidenced", () => {
    const result = clusterWithoutScopes([fileInsight("src/utils/index.ts")], [], []);
    expect(result.modules[0]).toMatchObject({ title: "Unknown", category: "unknown" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unknown-files",
      filePaths: ["src/utils/index.ts"]
    }));
  });
  it("keeps cohesive feature files together under a stable directory anchor", () => {
    const result = clusterWithoutScopes(
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
    expect(billing?.identity.anchor).toBe("directory:src/features/billing");
    expect(billing?.identity.id).toBe(billing?.id);
  });

  it("keeps a feature module ID when a new route entry file is added", () => {
    const initial = clusterWithoutScopes(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const before = moduleForFile(initial.modules, "src/features/billing/billing.service.ts");
    const updated = clusterWithoutScopes(
      [...moduleClusteringFixture.files, fileInsight("src/features/billing/route.ts")],
      moduleClusteringFixture.relations,
      []
    );
    const after = moduleForFile(updated.modules, "src/features/billing/billing.service.ts");

    expect(after?.id).toBe(before?.id);
    expect(after?.identity.anchor).toBe("directory:src/features/billing");
  });

  it("produces identical module IDs and file ownership for repeated inputs", () => {
    const first = clusterWithoutScopes(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const second = clusterWithoutScopes(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);

    expect(second).toEqual(first);
  });

  it("keeps distinct normalized anchor paths distinct even when their slug forms collide", () => {
    const result = clusterWithoutScopes([
      fileInsight("src/user-management/user.controller.ts"),
      fileInsight("src/user/management-user.controller.ts")
    ], [], []);

    expect(result.modules).toHaveLength(2);
    expect(new Set(result.modules.map((module) => module.id)).size).toBe(2);
    expect(new Set(result.modules.map((module) => module.identity.anchor)).size).toBe(2);
  });

  it("preserves boundary categories from filename suffixes", () => {
    const result = clusterWithoutScopes([
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
    const underThreshold = clusterWithoutScopes(moduleClusteringFixture.files, twoDomainRelations, []);
    const eligible = clusterWithoutScopes(
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
    const result = clusterWithoutScopes(files, relations, []);

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
    const result = clusterWithoutScopes([...moduleClusteringFixture.files, service], relations, []);

    expect(moduleForFile(result.modules, service.path)?.category).toBe("domain-service");
  });

  it("keeps the ID when ordinary files are added under the same anchor and updates the fingerprint", () => {
    const initial = clusterWithoutScopes(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const previousModules = initial.modules.map(toArchitectureModule);
    const updated = clusterWithoutScopes(
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
    const initial = clusterWithoutScopes(moduleClusteringFixture.files, moduleClusteringFixture.relations, []);
    const billing = moduleForFile(initial.modules, "src/features/billing/billing.service.ts");
    if (!billing) throw new Error("Expected a billing module in the fixture.");
    const splitParent = toArchitectureModule({
      ...billing,
      files: ["src/features/billing/billing.service.ts", "src/features/identity/identity.service.ts"]
    });
    const split = clusterWithoutScopes(moduleClusteringFixture.files, moduleClusteringFixture.relations, [splitParent]);
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
    const merged = clusterWithoutScopes(
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
    const initial = clusterWithoutScopes([
      fileInsight("src/main/billing.service.ts"),
      fileInsight("src/main/billing-format.service.ts")
    ], [], []);
    const previousModules = initial.modules.map(toArchitectureModule);
    const billingParent = moduleForFile(initial.modules, "src/main/billing.service.ts");
    const identityParent = moduleForFile(initial.modules, "src/main/billing-format.service.ts");
    if (!billingParent || !identityParent) throw new Error("Expected separate billing and identity modules.");
    const merged = clusterWithoutScopes([
      fileInsight("src/main/billing.service.ts"),
      fileInsight("src/main/billing.store.ts"),
      fileInsight("src/main/billing-format.service.ts")
    ], [relation("billing-calls-identity", "src/main/billing.service.ts", "src/main/billing-format.service.ts")], previousModules);
    const mergedBilling = moduleForFile(merged.modules, "src/main/billing.service.ts");

    expect(mergedBilling?.id).toBe(billingParent.id);
    expect(mergedBilling?.identity.predecessorIds).toEqual([billingParent.id, identityParent.id].sort());
  });

  it("keeps a named responsibility independent when its name does not establish auxiliary ownership", () => {
    const ui = "src/features/billing/BillingPanel.tsx";
    const service = "src/main/invoice.service.ts";
    const result = clusterWithoutScopes(
      [fileInsight(ui), fileInsight(service)],
      [relation("billing-panel-invoice", ui, service)],
      []
    );

    expect(moduleForFile(result.modules, ui)?.files).toEqual([ui]);
    expect(moduleForFile(result.modules, service)?.files).toEqual([service]);
  });

  it("keeps unclassified and oversized modules visible through diagnostics", () => {
    const oversizedFiles = Array.from({ length: 21 }, (_, index) =>
      fileInsight(`src/features/archive/archive-${index}.service.ts`)
    );
    const result = clusterWithoutScopes(
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
    const initial = clusterWithoutScopes(
      [fileInsight("src/index.ts"), fileInsight("src/app.ts")],
      [],
      []
    );
    const previousModules = initial.modules.map(toArchitectureModule);
    const updated = clusterWithoutScopes(
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

function clusterWithoutScopes(files: FileInsight[], relations: SemanticRelation[], previousModules: ArchitectureModule[]) {
  return clusterArchitectureModules(files, relations, previousModules, []);
}

function analysisScope(id: string, rootPath: string, paths: string[]): AnalysisScope {
  return { id, language: "typescript", rootPath, sourceRoots: [rootPath], paths, configurationPaths: [] };
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

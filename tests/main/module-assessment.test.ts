import { describe, expect, it } from "vitest";
import { assessModules } from "../../src/utils/module-assessment";
import { buildExecutionAssessmentSummary, buildGuidanceMarkdown, scopeGraphForModule } from "../../src/utils/export-artifacts";
import type { GraphEdge, GraphNode, SemanticIndex } from "../../src/types";

describe("module assessment", () => {
  it("produces deterministic evidence-backed confidence scores", () => {
    const index = semanticIndexFixture();
    const first = assessModules(modulesFixture(), edgesFixture(), index, "scan-1", "2026-06-15T00:00:00.000Z");
    const second = assessModules(modulesFixture(), edgesFixture(), index, "scan-1", "2026-06-15T00:00:00.000Z");

    expect(first).toEqual(second);
    expect(first[0].assessment?.confidence.level).toBe("high");
    expect(first[0].assessment?.confidence.factors).toHaveLength(5);
    expect(first[0].assessment?.risk.factors.every((factor) => factor.reason && factor.evidence.length > 0)).toBe(true);
  });

  it("raises impact risk for central modules with side effects and missing tests", () => {
    const [assessed] = assessModules(modulesFixture(), edgesFixture(), semanticIndexFixture(), "scan-1", "2026-06-15T00:00:00.000Z");

    expect(assessed.assessment?.risk.systemScore).toBeGreaterThanOrEqual(30);
    expect(assessed.assessment?.risk.systemLevel).not.toBe("low");
    expect(assessed.assessment?.risk.factors.map((factor) => factor.id)).toEqual([
      "sensitive-surface",
      "dependency-centrality",
      "side-effects",
      "change-impact",
      "test-protection"
    ]);
  });

  it("does not classify a module as high risk from an auth filename alone", () => {
    const module = graphNode("auth-label", ["src/auth-label.ts"]);
    const index = semanticIndexFixture({
      files: [{
        ...semanticIndexFixture().files[0],
        path: "src/auth-label.ts",
        insight: {
          path: "src/auth-label.ts",
          imports: [],
          exports: [],
          symbols: [],
          calls: [],
          externalCalls: []
        }
      }],
      symbols: [],
      relations: []
    });
    const [assessed] = assessModules([module], [], index, "scan-1", "2026-06-15T00:00:00.000Z");

    expect(assessed.assessment?.risk.systemLevel).not.toBe("high");
  });

  it("returns unknown confidence when a manual module has no semantic files", () => {
    const [assessed] = assessModules([graphNode("manual", ["src/missing.ts"])], [], semanticIndexFixture(), "scan-1", "2026-06-15T00:00:00.000Z");

    expect(assessed.assessment?.confidence.level).toBe("unknown");
    expect(assessed.assessment?.confidence.score).toBeUndefined();
    expect(assessed.assessment?.risk.systemLevel).toBe("unknown");
  });

  it("preserves a reasoned user risk override while refreshing the system score", () => {
    const module = graphNode("api", ["src/api.ts"]);
    module.assessment = {
      version: 1,
      generatorVersion: "1.0.0",
      confidence: { level: "low", factors: [] },
      risk: {
        systemLevel: "high",
        effectiveLevel: "high",
        factors: [],
        override: {
          level: "high",
          reason: "Production migration is coordinated manually.",
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      },
      fingerprint: "old",
      assessedAt: "2026-06-14T00:00:00.000Z"
    };

    const [assessed] = assessModules([module], edgesFixture(), semanticIndexFixture(), "scan-1", "2026-06-15T00:00:00.000Z");

    expect(assessed.assessment?.risk.effectiveLevel).toBe("high");
    expect(assessed.assessment?.risk.override?.reason).toContain("Production migration");
    expect(assessed.assessment?.risk.systemLevelChanged).toBe(true);
    expect(assessed.assessment?.generatorVersion).toBe("1.0.0");
    expect(assessed.risk).toBe("high");
  });

  it("includes actionable assessment details in Agent guidance and Execute summaries", () => {
    const assessed = assessModules(modulesFixture(), edgesFixture(), semanticIndexFixture(), "scan-1", "2026-06-15T00:00:00.000Z");
    assessed[0].technologyStack = "frontend";
    assessed[1].technologyStack = "backend";

    const guidance = buildGuidanceMarkdown("fixture", assessed, edgesFixture());
    const summary = buildExecutionAssessmentSummary(assessed, edgesFixture());

    expect(guidance).toContain("System risk:");
    expect(guidance).toContain("Risk evidence:");
    expect(summary).toContain("Highest module risk:");
    expect(summary).toContain("Lowest confidence:");
    expect(summary).toContain("Cross-stack connections: api -> service");
    expect(summary).toContain("Git Diff safety is evaluated independently");
  });

  it("scopes module Execute summaries to the selected module and directly connected modules", () => {
    const assessed = assessModules([
      ...modulesFixture(),
      { ...graphNode("billing", ["src/billing.ts"]), title: "Billing", risk: "high" }
    ], [
      ...edgesFixture(),
      { id: "billing-database", source: "billing", target: "database", relation: "reads_writes" }
    ], semanticIndexFixture({
      files: [...semanticIndexFixture().files, semanticFile("src/billing.ts")],
      relations: []
    }), "scan-1", "2026-06-15T00:00:00.000Z");
    const scoped = scopeGraphForModule(assessed, [
      ...edgesFixture(),
      { id: "billing-database", source: "billing", target: "database", relation: "reads_writes" }
    ], "service");
    const summary = buildExecutionAssessmentSummary(scoped.nodes, scoped.edges);

    expect(scoped.nodes.map((node) => node.id).sort()).toEqual(["api", "service"]);
    expect(scoped.edges.map((edge) => edge.id).sort()).toEqual(["api-service"]);
    expect(summary).not.toContain("Billing");
  });
});

function modulesFixture(): GraphNode[] {
  return [
    {
      ...graphNode("api", ["src/api.ts"]),
      nodeType: "api",
      symbols: [{ name: "handleRequest", kind: "function", filePath: "src/api.ts", line: 4 }],
      evidence: [{ filePath: "src/api.ts", symbol: "handleRequest", line: 4, detail: "HTTP request entrypoint" }]
    },
    graphNode("service", ["src/service.ts"]),
    graphNode("database", ["src/database.ts"])
  ];
}

function edgesFixture(): GraphEdge[] {
  return [
    {
      id: "api-service",
      source: "api",
      target: "service",
      relation: "calls",
      evidence: [{ filePath: "src/api.ts", symbol: "handleRequest", line: 7, detail: "Calls service" }]
    },
    {
      id: "api-database",
      source: "api",
      target: "database",
      relation: "reads_writes",
      evidence: [{ filePath: "src/api.ts", symbol: "saveUser", line: 9, detail: "Writes user data" }]
    }
  ];
}

function graphNode(id: string, files: string[]): GraphNode {
  return {
    id,
    title: id,
    subtitle: id,
    kind: "module",
    nodeType: "module",
    risk: "low",
    description: `${id} module`,
    files,
    guidanceDraft: "Review changes.",
    status: "mapped",
    x: 0,
    y: 0
  };
}

function semanticIndexFixture(overrides?: Partial<SemanticIndex>): SemanticIndex {
  const index: SemanticIndex = {
    version: 1,
    generatorVersion: "1.0.0",
    projectName: "fixture",
    rootPath: "/fixture",
    generatedAt: "2026-06-15T00:00:00.000Z",
    scanFingerprint: "scan-1",
    files: [
      {
        path: "src/api.ts",
        size: 120,
        modifiedAt: "2026-06-15T00:00:00.000Z",
        contentHash: "api",
        cacheKey: "api",
        analyzerId: "typescript",
        analysisDepth: "semantic",
        status: "parsed",
        diagnostics: [],
        insight: {
          path: "src/api.ts",
          imports: ["./service", "./database"],
          exports: ["handleRequest"],
          symbols: [{ name: "handleRequest", kind: "function", filePath: "src/api.ts", line: 4, signature: "() => Promise<void>" }],
          calls: ["saveUser"],
          externalCalls: [{ kind: "database", target: "users", filePath: "src/api.ts", symbol: "saveUser" }]
        },
        httpEndpoints: [],
        renderTargets: []
      },
      semanticFile("src/service.ts"),
      semanticFile("src/database.ts")
    ],
    symbols: [{ name: "handleRequest", kind: "function", filePath: "src/api.ts", line: 4, signature: "() => Promise<void>" }],
    relations: [
      {
        id: "api-service",
        kind: "call",
        source: "handleRequest",
        target: "service",
        sourceFile: "src/api.ts",
        targetFile: "src/service.ts",
        symbol: "handleRequest",
        detail: "API calls service",
        confidence: "confirmed"
      },
      {
        id: "api-db",
        kind: "database",
        source: "src/api.ts",
        target: "users",
        sourceFile: "src/api.ts",
        symbol: "saveUser",
        detail: "API writes users",
        confidence: "confirmed"
      }
    ],
    httpEndpoints: [],
    diagnostics: []
  };
  return { ...index, ...overrides };
}

function semanticFile(path: string): SemanticIndex["files"][number] {
  return {
    path,
    size: 80,
    modifiedAt: "2026-06-15T00:00:00.000Z",
    contentHash: path,
    cacheKey: path,
    analyzerId: "typescript",
    analysisDepth: "semantic",
    status: "parsed",
    diagnostics: [],
    insight: {
      path,
      imports: [],
      exports: [],
      symbols: [{ name: path, kind: "export", filePath: path, line: 1 }],
      calls: [],
      externalCalls: []
    },
    httpEndpoints: [],
    renderTargets: []
  };
}

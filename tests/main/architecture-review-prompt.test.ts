import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS,
  ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS,
  buildArchitectureReviewPrompt,
  type ArchitectureReviewPromptInput,
  type ArchitectureReviewPromptEvidence
} from "../../src/main/services/architecture-review-prompt.service";
import type { ArchitectureModule, ArchitectureRelationship } from "../../src/types";

describe("architecture-review-prompt.service", () => {
  it("sends the local graph without sending full structure facts or requesting topology", () => {
    const input = promptInput(8, 2);
    const prompt = buildArchitectureReviewPrompt(input);
    const schema = prompt.text.slice(prompt.text.indexOf("Review response schema:"));

    expect(prompt.text).toContain("service-module-0");
    expect(prompt.text).toContain('T:["calls"]');
    expect(prompt.text).toContain("Module 0 calls module 1.");
    expect(prompt.text).not.toContain("ProjectStructureFacts");
    expect(schema).not.toContain('"relationships"');
    expect(schema).not.toContain('"files"');
    expect(schema).not.toContain('"fileRoles"');
    expect(prompt.metrics.promptModuleCount).toBe(input.modules.length);
    expect(prompt.metrics.promptEdgeCount).toBe(input.relationships.length);
  });

  it("fits a 250-file-scale graph and deterministically selects bounded evidence", () => {
    const input = promptInput(40, 10);
    const first = buildArchitectureReviewPrompt(input);
    const second = buildArchitectureReviewPrompt(input);

    expect(first.text.length).toBeLessThanOrEqual(ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS);
    expect(first.metrics.promptChars).toBe(first.text.length);
    expect(first.metrics.promptEvidenceCount).toBeLessThan(input.evidence.length);
    expect(first.metrics.promptEvidenceCount).toBeGreaterThan(0);
    expect(first.metrics.promptEvidenceOmittedCount).toBe(input.evidence.length - first.metrics.promptEvidenceCount);
    expect(first.metrics.promptCoreChars + first.metrics.promptEvidenceChars).toBe(first.metrics.promptChars);
    const sourceBackedModuleIds = new Set(input.evidence
      .filter((item) => !item.relationshipId)
      .flatMap((item) => item.moduleIds));
    const coveredModuleIds = new Set(first.evidence
      .filter((item) => !item.relationshipId)
      .flatMap((item) => item.moduleIds));
    expect(coveredModuleIds).toEqual(sourceBackedModuleIds);
    expect(first.metrics.promptEvidenceCoveredModuleCount).toBe(sourceBackedModuleIds.size);
    expect(first.metrics.promptModuleWithoutSourceEvidenceCount).toBe(0);
    expect(first.text).toBe(second.text);
    expect(first.metrics).toEqual(second.metrics);
    expect(first.modules.map((module) => module.id)).toEqual(input.modules.map((module) => module.id).sort());
    expect(first.text).toContain("Module 0 calls module 1.");
    expect(first.text.match(/Module 0 calls module 1\./g)).toHaveLength(1);
    expect(first.text).toContain("Owns business workflow 0.");
    expect(first.text).toContain("service-module-0");
    expect(first.evidence.every((item) => item.id.length <= 20)).toBe(true);
  });

  it("reserves the best representative for every source-backed module before filling remaining capacity", () => {
    const input = promptInput(40, 2);
    input.evidence.push({
      ...input.evidence[0],
      id: "highest-priority-evidence-for-last-module",
      moduleIds: [input.modules[39].id],
      severity: "error",
      confidence: "confirmed"
    });

    const prompt = buildArchitectureReviewPrompt(input);
    const selectedModuleIds = new Set(prompt.evidence
      .filter((item) => !item.relationshipId)
      .flatMap((item) => item.moduleIds));

    expect(selectedModuleIds).toEqual(new Set(input.modules.map((module) => module.id)));
    expect(prompt.evidence.some((item) => item.moduleIds.includes(input.modules[39].id) && item.severity === "error")).toBe(true);
    expect(prompt.metrics.promptEvidenceCoveredModuleCount).toBe(40);
  });

  it("fills optional evidence while mandatory evidence remains below the soft target", () => {
    const input = promptInput(3, 5);
    const prompt = buildArchitectureReviewPrompt(input);
    const mandatoryCount = new Set(input.evidence
      .filter((item) => !item.relationshipId)
      .flatMap((item) => item.moduleIds)).size;

    expect(prompt.metrics.promptChars).toBeLessThanOrEqual(ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS);
    expect(prompt.metrics.promptEvidenceCount).toBeGreaterThan(mandatoryCount);
  });

  it("keeps all mandatory evidence above the soft target and below the hard limit", () => {
    const input = promptInput(40, 1);
    input.evidence = input.evidence.map((item) => ({ ...item, detail: "x" }));

    const prompt = buildArchitectureReviewPrompt(input);

    expect(prompt.metrics.promptChars).toBeGreaterThan(ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS);
    expect(prompt.metrics.promptChars).toBeLessThanOrEqual(ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS);
    expect(prompt.metrics.promptEvidenceCount).toBe(40);
  });

  it("fails when mandatory evidence alone exceeds the hard prompt limit", () => {
    const input = promptInput(40, 1);
    input.evidence = input.evidence.map((item) => ({ ...item, detail: "x".repeat(160) }));

    expect(() => buildArchitectureReviewPrompt(input)).toThrow(
      /ARCHITECTURE_PROMPT_BUDGET_EXCEEDED: modules=40 edges=80 actualChars=\d+ budget=12000 largestContribution=evidence:/
    );
  });

  it("counts only modules without source evidence", () => {
    const input = promptInput(3, 1);
    input.evidence = input.evidence.filter((item) => !item.moduleIds.includes(input.modules[1].id));

    const prompt = buildArchitectureReviewPrompt(input);

    expect(prompt.metrics.promptEvidenceCoveredModuleCount).toBe(2);
    expect(prompt.metrics.promptModuleWithoutSourceEvidenceCount).toBe(1);
  });

  it("trims oversized evidence while keeping the core graph under its hard budget", () => {
    const input = promptInput(2, 1);
    input.evidence = input.evidence.map((item) => ({
      ...item,
      detail: `${item.detail} ${"large-evidence ".repeat(1_300)}`
    }));

    const prompt = buildArchitectureReviewPrompt(input);

    expect(prompt.text.length).toBeLessThanOrEqual(ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS);
    expect(prompt.metrics.promptEvidenceTruncatedCount).toBe(2);
    expect(prompt.evidence.every((item) => item.detail.includes("large-evidence"))).toBe(true);
    expect(prompt.text).not.toContain("large-evidence ".repeat(20));
  });

  it("reports graph counts, actual prompt size, budget, and largest section when over budget", () => {
    expect(() => buildArchitectureReviewPrompt(promptInput(150, 2))).toThrow(
      /ARCHITECTURE_PROMPT_BUDGET_EXCEEDED: modules=150 edges=300 actualChars=\d+ budget=12000 largestContribution=(module|edge|prompt-instructions)/
    );
  });
});

function promptInput(moduleCount: number, evidencePerModule: number): ArchitectureReviewPromptInput {
  const modules = Array.from({ length: moduleCount }, (_, index) => architectureModule(index));
  const relationships = Array.from({ length: moduleCount * 2 }, (_, index) => architectureRelationship(index, moduleCount));
  const evidence = modules.flatMap((module, index) => Array.from({ length: evidencePerModule }, (_, item) => ({
    id: `evidence-${String(index).padStart(3, "0")}-${String(item).padStart(2, "0")}`,
    moduleIds: [module.id],
    filePath: module.files[item % module.files.length],
    symbol: module.symbols[item % module.symbols.length].name,
    detail: `Confirmed source behavior ${item} for ${module.id}.`,
    confidence: item === 0 ? "confirmed" as const : "inferred" as const,
    severity: "info" as const
  } satisfies ArchitectureReviewPromptEvidence)));

  return {
    projectName: "flowweave-250-file-fixture",
    modules,
    relationships,
    evidence
  };
}

function architectureModule(index: number): ArchitectureModule {
  const id = `service-module-${index}`;
  const files = Array.from({ length: 5 }, (_, item) => `src/features/feature-${index}/part-${item}.ts`);
  const symbols = Array.from({ length: 8 }, (_, item) => ({
    name: `serviceFunction${item}`,
    kind: "function" as const,
    filePath: files[item % files.length]
  }));
  return {
    id,
    title: `Service Module ${index}`,
    category: "domain-service",
    nodeType: "service",
    role: `Owns business workflow ${index}.`,
    description: `Long description for workflow ${index}.`,
    files,
    fileRoles: files.map((path) => ({ path, role: "Implementation file." })),
    symbols,
    evidence: [],
    risk: "unknown"
  };
}

function architectureRelationship(index: number, moduleCount: number): ArchitectureRelationship {
  const source = index % moduleCount;
  const target = (source + 1) % moduleCount;
  return {
    id: `edge-${String(index).padStart(3, "0")}`,
    source: `service-module-${source}`,
    target: `service-module-${target}`,
    relation: "calls",
    description: `Module ${source} calls module ${target}.`,
    evidence: []
  };
}

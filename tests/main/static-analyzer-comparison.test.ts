import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  compareAnalyzerResults,
  createLabelSetSha256,
  type AnalyzerEvidenceSet,
  type AnalyzerFact,
  type AnalyzerTargetIdentity,
  type FileScopeEntry,
  type LabeledEvidenceSet,
  type LabeledEvidenceFact
} from "../../scripts/compare-static-analyzers";

describe("compareAnalyzerResults", () => {
  it("measures dependency imports separately from confirmed calls", () => {
    const { baseline, candidate, labels } = createFixture();
    const result = compareAnalyzerResults(baseline, candidate, labels);

    expect(result.baseline.dependencies).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0 });
    expect(result.baseline.confirmedCalls).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
    expect(result.candidate.dependencies).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
    expect(result.candidate.confirmedCalls).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 1 });
    expect(result.candidate.confirmedCalls.f1).toBe(0);
    expect(result.identities.baseline.tool).toEqual({ name: "flowweave", version: "0.1.0" });
    expect(result.identities.candidate.dependencies).toEqual([{ name: "scip-java", version: "0.3.4" }]);
  });

  it("does not count inferred calls as confirmed-call predictions", () => {
    const { baseline, candidate, labels } = createFixture();
    const inferredOnly: AnalyzerEvidenceSet = {
      ...candidate,
      facts: candidate.facts.map((fact) => fact.factId === "call:expected" ? { factId: fact.factId, fileId: fact.fileId, kind: "call", confidence: "inferred" } : fact)
    };

    const result = compareAnalyzerResults(baseline, inferredOnly, labels);

    expect(result.candidate.confirmedCalls).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 1 });
  });

  it("rejects a prediction that has no matching labeled fact identity", () => {
    const { baseline, candidate, labels } = createFixture();
    const facts = labels.facts.filter((fact) => fact.factId !== "dependency:false-positive");
    const incompleteLabels: LabeledEvidenceSet = {
      ...labels,
      identity: { ...labels.identity, labelSetSha256: createLabelSetSha256(facts) },
      facts
    };

    expect(() => compareAnalyzerResults(baseline, candidate, incompleteLabels)).toThrow(/missing label/i);
  });

  it("rejects stale source evidence even when file paths still match", () => {
    const { baseline, candidate, labels } = createFixture();
    const staleCandidate: AnalyzerEvidenceSet = {
      ...candidate,
      fileScope: candidate.fileScope.map((file) => file.fileId === "src/service.ts" ? { ...file, contentSha256: "f".repeat(64) } : file)
    };

    expect(() => compareAnalyzerResults(baseline, staleCandidate, labels)).toThrow(/source manifest/i);
  });

  it("rejects relation target files outside the hash-bound source scope", () => {
    const { baseline, candidate, labels } = createFixture();
    const targetIdentity = { kind: "file", fileId: "src/outside.ts" };

    expect(() => compareAnalyzerResults(withAnalyzerTarget(baseline, "dependency:expected", targetIdentity), candidate, labels))
      .toThrow(/target file.*outside.*scope/i);
    expect(() => compareAnalyzerResults(baseline, withAnalyzerTarget(candidate, "dependency:expected", targetIdentity), labels))
      .toThrow(/target file.*outside.*scope/i);
    expect(() => compareAnalyzerResults(baseline, candidate,
      withLabelTarget(labels, "dependency:expected", targetIdentity, true)))
      .toThrow(/target file.*outside.*scope/i);
  });

  it.each(["baseline", "candidate", "labels"] as const)("rejects a %s target identity that conflicts for the same fact ID", (conflictingSet) => {
    const { baseline, candidate, labels } = createFixture();
    const targetIdentity = { kind: "symbol", fileId: "src/service.ts", identity: "Service.getUser" };
    const conflictingTarget = { ...targetIdentity, identity: "Service.deleteUser" };
    const baselineWithTarget = withAnalyzerTarget(baseline, "call:expected", targetIdentity);
    const candidateWithTarget = withAnalyzerTarget(candidate, "call:expected", targetIdentity);
    const labelsWithTarget = withLabelTarget(labels, "call:expected", targetIdentity, true);
    const conflictingBaseline = conflictingSet === "baseline"
      ? withAnalyzerTarget(baselineWithTarget, "call:expected", conflictingTarget)
      : baselineWithTarget;
    const conflictingCandidate = conflictingSet === "candidate"
      ? withAnalyzerTarget(candidateWithTarget, "call:expected", conflictingTarget)
      : candidateWithTarget;
    const conflictingLabels = conflictingSet === "labels"
      ? withLabelTarget(labelsWithTarget, "call:expected", conflictingTarget, true)
      : labelsWithTarget;

    expect(() => compareAnalyzerResults(conflictingBaseline, conflictingCandidate, conflictingLabels))
      .toThrow(/target identity/i);
  });

  it("binds labeled target identities into the label-set hash", () => {
    const { baseline, candidate, labels } = createFixture();
    const labelsWithTarget = withLabelTarget(labels, "call:expected", {
      kind: "symbol", fileId: "src/service.ts", identity: "Service.getUser"
    }, false);

    expect(() => compareAnalyzerResults(baseline, candidate, labelsWithTarget)).toThrow(/label set SHA-256/i);
  });

  it("requires named targets to use normalized Unicode identities", () => {
    const { baseline, candidate, labels } = createFixture();
    const decomposedIdentity = "Cafe\u0301Service.getUser";
    const baselineWithTarget = withAnalyzerTarget(baseline, "call:expected", {
      kind: "symbol", fileId: "src/service.ts", identity: decomposedIdentity
    });
    const candidateWithTarget = withAnalyzerTarget(candidate, "call:expected", {
      kind: "symbol", fileId: "src/service.ts", identity: decomposedIdentity
    });
    const labelsWithTarget = withLabelTarget(labels, "call:expected", {
      kind: "symbol", fileId: "src/service.ts", identity: decomposedIdentity
    }, true);

    expect(() => compareAnalyzerResults(baselineWithTarget, candidateWithTarget, labelsWithTarget))
      .toThrow(/normalized Unicode/i);
  });

  it("rejects duplicate or ambiguous label facts instead of scoring them", () => {
    const { baseline, candidate, labels } = createFixture();
    const duplicateLabels: LabeledEvidenceSet = { ...labels, facts: [...labels.facts, labels.facts[0]] };
    const ambiguousLabels: LabeledEvidenceSet = {
      ...labels,
      facts: labels.facts.map((fact) => fact.factId === "call:expected" ? { ...fact, status: "ambiguous" } : fact)
    };

    expect(() => compareAnalyzerResults(baseline, candidate, duplicateLabels)).toThrow(/duplicate.*label/i);
    expect(() => compareAnalyzerResults(baseline, candidate, ambiguousLabels)).toThrow(/ambiguous/i);
  });

  it("rejects an empty label set instead of returning empty comparison metrics", () => {
    const { baseline, candidate, labels } = createFixture();
    const facts: LabeledEvidenceFact[] = [];
    const emptyLabels: LabeledEvidenceSet = {
      ...labels,
      identity: { ...labels.identity, labelSetSha256: createLabelSetSha256(facts) },
      facts
    };

    expect(() => compareAnalyzerResults(baseline, candidate, emptyLabels)).toThrow(/no labeled facts/i);
  });

  it("rejects mismatched comparison configuration and incomplete tool identities", () => {
    const { baseline, candidate, labels } = createFixture();
    const mismatchedConfig: AnalyzerEvidenceSet = {
      ...candidate,
      identity: { ...candidate.identity, comparisonConfigSha256: "e".repeat(64) }
    };
    const unknownVersion: AnalyzerEvidenceSet = {
      ...candidate,
      identity: { ...candidate.identity, tool: { name: "scip-java", version: "unknown" } }
    };
    const rangeVersions = ["1.2.x", "1.x", "1.2.3 - 2.0.0", ">=1.2.3 <2.0.0"];

    expect(() => compareAnalyzerResults(baseline, mismatchedConfig, labels)).toThrow(/comparison config/i);
    expect(() => compareAnalyzerResults(baseline, unknownVersion, labels)).toThrow(/tool version/i);
    for (const version of rangeVersions) {
      const rangedIdentity: AnalyzerEvidenceSet = {
        ...candidate,
        identity: { ...candidate.identity, tool: { name: "scip-java", version } }
      };
      expect(() => compareAnalyzerResults(baseline, rangedIdentity, labels)).toThrow(/exact, recorded version/i);
    }
  });

  it("writes a deterministic comparison artifact from explicit evidence files", async () => {
    const { baseline, candidate, labels } = createFixture();
    const directory = await mkdtemp(join(tmpdir(), "flowweave-analyzer-compare-"));
    const baselinePath = join(directory, "baseline.json");
    const candidatePath = join(directory, "candidate.json");
    const labelsPath = join(directory, "labels.json");
    const outputPath = join(directory, "analyzer-comparison.json");
    const scriptPath = resolve("scripts/compare-static-analyzers.ts");

    try {
      await Promise.all([
        writeFile(baselinePath, JSON.stringify(baseline), "utf8"),
        writeFile(candidatePath, JSON.stringify(candidate), "utf8"),
        writeFile(labelsPath, JSON.stringify(labels), "utf8")
      ]);
      const cliResult = spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--baseline", baselinePath, "--candidate", candidatePath, "--labels", labelsPath, "--out", outputPath], { encoding: "utf8" });

      expect(cliResult.status).toBe(0);
      expect(cliResult.stderr).toBe("");
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(compareAnalyzerResults(baseline, candidate, labels));
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

function createFixture(): { baseline: AnalyzerEvidenceSet; candidate: AnalyzerEvidenceSet; labels: LabeledEvidenceSet } {
  const fileScope: FileScopeEntry[] = [
    { fileId: "src/service.ts", path: "src/service.ts", contentSha256: "1".repeat(64) },
    { fileId: "src/client.ts", path: "src/client.ts", contentSha256: "2".repeat(64) }
  ];
  const sourceManifestSha256 = hashJson([...fileScope].sort(compareFileId));
  const comparisonConfigSha256 = "a".repeat(64);
  const labeledFacts: LabeledEvidenceFact[] = [
    { factId: "dependency:expected", fileId: "src/client.ts", kind: "dependency", status: "present" },
    { factId: "dependency:false-positive", fileId: "src/service.ts", kind: "dependency", status: "absent" },
    { factId: "call:expected", fileId: "src/service.ts", kind: "confirmed-call", status: "present" },
    { factId: "call:false-positive", fileId: "src/client.ts", kind: "confirmed-call", status: "absent" }
  ];
  const labels: LabeledEvidenceSet = {
    identity: { sourceManifestSha256, comparisonConfigSha256, labelSetSha256: hashJson([...labeledFacts].sort(compareFactId)) },
    fileScope,
    facts: labeledFacts
  };
  const baselineFacts: AnalyzerFact[] = [
    { factId: "dependency:expected", fileId: "src/client.ts", kind: "dependency" },
    { factId: "dependency:false-positive", fileId: "src/service.ts", kind: "dependency" },
    { factId: "call:expected", fileId: "src/service.ts", kind: "call", confidence: "confirmed" },
    { factId: "call:false-positive", fileId: "src/client.ts", kind: "call", confidence: "inferred" }
  ];
  const candidateFacts: AnalyzerFact[] = [
    { factId: "dependency:expected", fileId: "src/client.ts", kind: "dependency" },
    { factId: "call:expected", fileId: "src/service.ts", kind: "call", confidence: "inferred" }
  ];

  return {
    baseline: createEvidence("flowweave", "0.1.0", "b", [], sourceManifestSha256, comparisonConfigSha256, fileScope, baselineFacts),
    candidate: createEvidence("scip-java", "0.3.4", "c", [{ name: "scip-java", version: "0.3.4" }], sourceManifestSha256, comparisonConfigSha256, fileScope, candidateFacts),
    labels
  };
}

function createEvidence(toolName: string, toolVersion: string, configHashChar: string, dependencies: AnalyzerEvidenceSet["identity"]["dependencies"], sourceManifestSha256: string, comparisonConfigSha256: string, fileScope: FileScopeEntry[], facts: AnalyzerFact[]): AnalyzerEvidenceSet {
  return {
    identity: {
      sourceManifestSha256,
      comparisonConfigSha256,
      analyzerConfigSha256: configHashChar.repeat(64),
      tool: { name: toolName, version: toolVersion },
      dependencies
    },
    fileScope,
    facts
  };
}

function withAnalyzerTarget(evidence: AnalyzerEvidenceSet, factId: string, targetIdentity: AnalyzerTargetIdentity): AnalyzerEvidenceSet {
  let found = false;
  const facts = evidence.facts.map((fact) => {
    if (fact.factId !== factId) return fact;
    found = true;
    return { ...fact, targetIdentity };
  });
  if (!found) throw new Error(`Missing fixture analyzer fact ${factId}.`);
  return { ...evidence, facts };
}

function withLabelTarget(labels: LabeledEvidenceSet, factId: string, targetIdentity: AnalyzerTargetIdentity, refreshHash: boolean): LabeledEvidenceSet {
  let found = false;
  const facts = labels.facts.map((fact) => {
    if (fact.factId !== factId) return fact;
    found = true;
    return { ...fact, targetIdentity };
  });
  if (!found) throw new Error(`Missing fixture labeled fact ${factId}.`);
  return {
    ...labels,
    identity: { ...labels.identity, labelSetSha256: refreshHash ? createLabelSetSha256(facts) : labels.identity.labelSetSha256 },
    facts
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareFileId(left: FileScopeEntry, right: FileScopeEntry): number {
  return left.fileId.localeCompare(right.fileId);
}

function compareFactId(left: { factId: string }, right: { factId: string }): number {
  return left.factId.localeCompare(right.factId);
}

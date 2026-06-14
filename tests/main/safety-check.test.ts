import { describe, expect, it } from "vitest";
import { checkSafety } from "../../src/main/services/safety-check.service";
import type { ChangedFile } from "../../src/types";

describe("safety-check.service", () => {
  it("blocks sensitive file changes", () => {
    const result = checkSafety([
      file(".env", "modified"),
      file("config\\credentials.local.json", "modified")
    ]);

    expect(result.level).toBe("blocked");
    expect(result.warnings.filter((warning) => warning.code === "sensitive-file")).toHaveLength(2);
  });

  it("requires review for many deletions and large changes", () => {
    const deleted = Array.from({ length: 6 }, (_, index) => file(`src/${index}.ts`, "deleted"));
    const result = checkSafety([...deleted, file("src/large.ts", "modified", 501, 0)]);

    expect(result.level).toBe("review");
    expect(result.warnings.map((warning) => warning.code)).toContain("many-deletions");
    expect(result.warnings.map((warning) => warning.code)).toContain("large-file-change");
  });
});

function file(path: string, status: ChangedFile["status"], additions = 1, deletions = 1): ChangedFile {
  return { path, status, additions, deletions };
}

import { describe, expect, it } from "vitest";
import { resolveProjectImport } from "../../src/main/services/project-import-resolver.service";

describe("project-import-resolver.service", () => {
  it("resolves only project-relative imports against scanned file paths", () => {
    const projectFiles = new Set(["src/user.ts", "src/auth/index.ts"]);

    expect(resolveProjectImport("src/api.ts", "./user", projectFiles)).toBe("src/user.ts");
    expect(resolveProjectImport("src/api.ts", "./auth", projectFiles)).toBe("src/auth/index.ts");
    expect(resolveProjectImport("src/api.ts", "react", projectFiles)).toBeUndefined();
  });
});

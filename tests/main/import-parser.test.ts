import { describe, expect, it } from "vitest";
import { parseImportSpecifiers, resolveProjectImport } from "../../src/main/services/import-parser.service";

describe("import-parser.service", () => {
  it("parses relative import, export, require, and dynamic import specifiers", () => {
    const specifiers = parseImportSpecifiers(`
      import { user } from "./user.service";
      export { auth } from "../auth";
      const db = require("./database/client");
      const lazy = import("./lazy");
    `);

    expect(specifiers).toEqual(["./user.service", "../auth", "./database/client", "./lazy"]);
  });

  it("ignores imports inside comments", () => {
    const specifiers = parseImportSpecifiers(`
      // import bad from "./commented";
      /* const x = require("./blocked"); */
      import good from "./good";
    `);

    expect(specifiers).toEqual(["./good"]);
  });

  it("resolves only project-relative imports", () => {
    const projectFiles = new Set(["src/user.ts", "src/auth/index.ts"]);

    expect(resolveProjectImport("src/api.ts", "./user", projectFiles)).toBe("src/user.ts");
    expect(resolveProjectImport("src/api.ts", "./auth", projectFiles)).toBe("src/auth/index.ts");
    expect(resolveProjectImport("src/api.ts", "react", projectFiles)).toBeUndefined();
  });
});

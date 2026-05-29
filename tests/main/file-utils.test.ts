import { describe, expect, it } from "vitest";
import { flattenVisibleProjectFiles } from "../../src/utils/file-utils";
import type { ProjectFileNode } from "../../src/types";

describe("file-utils", () => {
  it("shows only root rows when every folder is collapsed", () => {
    const result = flattenVisibleProjectFiles(createTree(), new Set(), 100);

    expect(result.rows.map((row) => row.path)).toEqual(["src", "package.json"]);
  });

  it("shows children after expanding a parent folder", () => {
    const result = flattenVisibleProjectFiles(createTree(), new Set(["src", "src/auth"]), 100);

    expect(result.rows.map((row) => row.path)).toEqual(["src", "src/auth", "src/auth/index.ts", "package.json"]);
  });

  it("truncates visible rows when the maximum is reached", () => {
    const result = flattenVisibleProjectFiles(createTree(), new Set(["src", "src/auth"]), 2);

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.at(-1)?.isTruncatedNotice).toBe(true);
  });
});

function createTree(): ProjectFileNode[] {
  return [
    {
      id: "src",
      name: "src",
      path: "src",
      type: "folder",
      depth: 0,
      children: [
        {
          id: "src/auth",
          name: "auth",
          path: "src/auth",
          type: "folder",
          depth: 1,
          children: [
            {
              id: "src/auth/index.ts",
              name: "index.ts",
              path: "src/auth/index.ts",
              type: "file",
              depth: 2
            }
          ]
        }
      ]
    },
    {
      id: "package.json",
      name: "package.json",
      path: "package.json",
      type: "file",
      depth: 0
    }
  ];
}

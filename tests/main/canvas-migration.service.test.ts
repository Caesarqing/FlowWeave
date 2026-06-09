import { describe, expect, it } from "vitest";
import { migrateCanvasToScan } from "../../src/main/services/canvas-migration.service";
import type { CodeflowCanvas, ProjectFileNode } from "../../src/types";

describe("canvas-migration.service", () => {
  it("preserves user nodes while removing invalid files and edges", () => {
    const canvas: CodeflowCanvas = {
      version: 1,
      id: "main",
      title: "Main Canvas",
      projectPath: "/old",
      generatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [
        {
          id: "api",
          title: "API",
          subtitle: "Custom",
          kind: "module",
          nodeType: "api",
          risk: "normal",
          description: "User edited",
          files: ["src/api.ts", "src/deleted.ts"],
          fileRoles: [
            { path: "src/api.ts", role: "API entrypoint" },
            { path: "src/deleted.ts", role: "Deleted file" }
          ],
          symbols: [
            { name: "handle", kind: "function", filePath: "src/api.ts" },
            { name: "removed", kind: "function", filePath: "src/deleted.ts" }
          ],
          evidence: [
            { filePath: "src/api.ts", detail: "Current evidence" },
            { filePath: "src/deleted.ts", detail: "Deleted evidence" }
          ],
          x: 120,
          y: 240
        },
        {
          id: "service",
          title: "Service",
          subtitle: "Custom",
          kind: "module",
          nodeType: "service",
          risk: "normal",
          description: "User edited",
          files: ["src/service.ts"],
          x: 480,
          y: 240
        }
      ],
      edges: [
        {
          id: "valid",
          source: "api",
          target: "service",
          relation: "calls",
          guidanceNote: "src/api.ts imports service",
          evidence: [
            { filePath: "src/api.ts", symbol: "callService", detail: "Calls the service" },
            { filePath: "src/deleted.ts", detail: "Deleted evidence" }
          ]
        },
        { id: "duplicate", source: "api", target: "service", relation: "calls" },
        { id: "invalid", source: "api", target: "missing", relation: "calls" },
        {
          id: "stale-evidence",
          source: "service",
          target: "api",
          relation: "depends_on",
          guidanceNote: "node_modules/pkg/index.js imports api"
        }
      ]
    };
    const files: ProjectFileNode[] = [
      {
        id: "src",
        name: "src",
        path: "src",
        type: "folder",
        depth: 0,
        children: [
          { id: "src/api.ts", name: "api.ts", path: "src/api.ts", type: "file", depth: 1 },
          { id: "src/service.ts", name: "service.ts", path: "src/service.ts", type: "file", depth: 1 }
        ]
      }
    ];

    const migrated = migrateCanvasToScan(canvas, "/project", "scan-new", files);

    expect(migrated).toMatchObject({
      version: 2,
      projectPath: "/project",
      scanFingerprint: "scan-new",
      artifactState: "current"
    });
    expect(migrated.nodes[0]).toMatchObject({
      x: 120,
      y: 240,
      description: "User edited",
      files: ["src/api.ts"],
      fileRoles: [{ path: "src/api.ts", role: "API entrypoint" }],
      symbols: [{ name: "handle", kind: "function", filePath: "src/api.ts" }],
      evidence: [{ filePath: "src/api.ts", detail: "Current evidence" }]
    });
    expect(migrated.edges).toEqual([
      {
        id: "valid",
        source: "api",
        target: "service",
        relation: "calls",
        guidanceNote: "src/api.ts imports service",
        evidence: [{ filePath: "src/api.ts", symbol: "callService", detail: "Calls the service" }]
      }
    ]);
  });
});

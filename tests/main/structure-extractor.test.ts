import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectStructureFacts,
  extractLightweightInsight,
  extractTypeScriptInsight
} from "../../src/main/services/structure-extractor.service";
import type { CodeflowProject } from "../../src/types";

describe("structure-extractor.service", () => {
  it("extracts TypeScript imports, exports, symbols, calls, and external API hints", () => {
    const insight = extractTypeScriptInsight(
      "src/api/user.controller.ts",
      `
import axios from "axios";
import { userService } from "../service/user.service";
export class UserController {
  async load() {
    return axios.get("https://example.com/users");
  }
}
export const handler = () => fetch("/api/users");
`
    );

    expect(insight.imports).toContain("axios");
    expect(insight.imports).toContain("../service/user.service");
    expect(insight.exports).toEqual(expect.arrayContaining(["UserController", "handler"]));
    expect(insight.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "UserController", kind: "class" })]));
    expect(insight.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "handler", kind: "function" })]));
    expect(insight.calls).toEqual(expect.arrayContaining(["axios.get", "fetch"]));
    expect(insight.externalCalls).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "http" })]));
  });

  it("extracts lightweight Python imports and definitions", () => {
    const insight = extractLightweightInsight(
      "app/services/payment.py",
      `
import requests
from app.db import repository

class PaymentService:
    pass

def sync_payment():
    requests.get("https://example.com")
`
    );

    expect(insight.imports).toEqual(expect.arrayContaining(["requests", "app.db"]));
    expect(insight.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "PaymentService", kind: "class" })]));
    expect(insight.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sync_payment", kind: "function" })]));
    expect(insight.externalCalls).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "http" })]));
  });

  it("builds project structure facts from scanned project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-structure-"));
    await mkdir(join(root, "src/api"), { recursive: true });
    await writeFile(join(root, "src/api/index.ts"), 'export function api() { return fetch("/users"); }\n', "utf8");

    const facts = await buildProjectStructureFacts(projectFixture(root));

    expect(facts.projectName).toBe("structure-fixture");
    expect(facts.files).toHaveLength(1);
    expect(facts.files[0].path).toBe("src/api/index.ts");
    expect(facts.files[0].symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "api" })]));
  });
});

function projectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "structure-fixture",
    rootPath,
    generatedAt: "2026-05-30T00:00:00.000Z",
    git: { isRepo: false },
    summary: { totalFiles: 1, totalFolders: 2, languages: { TypeScript: 1 } },
    files: [
      {
        id: "src",
        name: "src",
        path: "src",
        type: "folder",
        depth: 0,
        children: [
          {
            id: "src/api",
            name: "api",
            path: "src/api",
            type: "folder",
            depth: 1,
            children: [
              {
                id: "src/api/index.ts",
                name: "index.ts",
                path: "src/api/index.ts",
                type: "file",
                depth: 2,
                language: "TypeScript"
              }
            ]
          }
        ]
      }
    ]
  };
}

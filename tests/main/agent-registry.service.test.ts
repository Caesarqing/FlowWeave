import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configureAgentRegistry,
  deleteCustomAgent,
  getAgentAdapter,
  listAgentDefinitions,
  saveCustomAgent
} from "../../src/main/services/agent-registry.service";
import { startToolPlan } from "../../src/main/services/agent-run.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";

describe("agent-registry.service", () => {
  it("lists built-in agents without exposing the mock adapter as a user agent", async () => {
    configureAgentRegistry(await mkdtemp(join(tmpdir(), "flowweave-agents-")));

    const agents = await listAgentDefinitions();

    expect(agents.map((agent) => agent.id)).toEqual([
      "claude-code",
      "claude-desktop",
      "codex-local",
      "codex-desktop",
      "gemini-cli",
      "cursor"
    ]);
    expect(agents.some((agent) => agent.id === "custom:mock")).toBe(false);
  });

  it("saves, lists, and deletes custom CLI agents", async () => {
    configureAgentRegistry(await mkdtemp(join(tmpdir(), "flowweave-agents-")));

    const agent = await saveCustomAgent({
      name: "Gemini CLI",
      command: "gemini",
      args: ["--model", "pro"],
      description: "Local Gemini CLI adapter."
    });
    const withCustom = await listAgentDefinitions();

    expect(agent.id).toBe("custom:gemini-cli");
    expect(withCustom).toContainEqual(expect.objectContaining({ id: "custom:gemini-cli", command: "gemini", args: ["--model", "pro"] }));

    await deleteCustomAgent(agent.id);
    const afterDelete = await listAgentDefinitions();
    expect(afterDelete.some((item) => item.id === agent.id)).toBe(false);
  });

  it("marks missing custom CLI commands unavailable without blocking persistence", async () => {
    configureAgentRegistry(await mkdtemp(join(tmpdir(), "flowweave-agents-")));

    const agent = await saveCustomAgent({
      name: "Missing CLI",
      command: "/definitely/not/a/flowweave/agent"
    });
    const adapter = await getAgentAdapter(agent.id);

    await expect(adapter.detect()).resolves.toMatchObject({
      toolId: agent.id,
      available: false,
      method: "none"
    });
  });

  it("runs custom CLI agents through stdin and writes run artifacts", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-agents-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-custom-agent-"));
    const scriptPath = join(configRoot, "stdin-agent.mjs");
    configureAgentRegistry(configRoot);
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    await writeFile(
      scriptPath,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  console.log('# Custom CLI Plan');",
        "  console.log(input.includes('Analyze auth module') ? 'received prompt' : 'missing prompt');",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Node stdin agent",
      command: process.execPath,
      args: [scriptPath],
      description: "Test CLI adapter."
    });

    const result = await startToolPlan({
      projectPath,
      toolId: agent.id,
      prompt: "Analyze auth module",
      executionMode: "plan"
    });

    expect(result.status).toBe("completed");
    await expect(readFile(result.promptPath ?? "", "utf8")).resolves.toContain("Analyze auth module");
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("received prompt");
    await expect(readFile(result.resultPath ?? "", "utf8")).resolves.toContain(`"toolId": "${agent.id}"`);
  });
});

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
import { registerProject } from "../../src/main/services/project-registry.service";
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
      command: process.execPath,
      args: ["--model", "pro"],
      description: "Local Gemini CLI adapter."
    });
    const withCustom = await listAgentDefinitions();

    expect(agent.id).toBe("custom:gemini-cli");
    expect(withCustom).toContainEqual(expect.objectContaining({
      id: "custom:gemini-cli",
      command: process.execPath,
      args: ["--model", "pro"],
      protocol: "cli-stdin",
      capabilities: ["execute"]
    }));

    await deleteCustomAgent(agent.id);
    const afterDelete = await listAgentDefinitions();
    expect(afterDelete.some((item) => item.id === agent.id)).toBe(false);
  });

  it("rejects missing custom CLI executables when saving", async () => {
    configureAgentRegistry(await mkdtemp(join(tmpdir(), "flowweave-agents-")));

    await expect(saveCustomAgent({
      name: "Missing CLI",
      command: "/definitely/not/a/flowweave/agent"
    })).rejects.toThrow("Agent executable was not found or is not executable");
  });

  it("rejects custom CLI plan runs without declared read-only capabilities", async () => {
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

    const projectId = await registerProject(projectPath);
    await expect(startToolPlan({
      projectId,
      toolId: agent.id,
      prompt: "Analyze auth module",
      executionMode: "plan",
      purpose: "implementation-plan"
    })).rejects.toThrow("does not declare a verifiable read-only Plan mode");
  });

  it("runs custom CLI plan agents through stdin and writes run artifacts", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-agents-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-custom-agent-"));
    const scriptPath = join(configRoot, "stdin-plan-agent.mjs");
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
      name: "Node stdin plan agent",
      command: process.execPath,
      planArgs: [scriptPath],
      capabilities: ["artifact-analysis", "implementation-plan"],
      description: "Test CLI plan adapter."
    });

    const projectId = await registerProject(projectPath);
    const result = await startToolPlan({
      projectId,
      toolId: agent.id,
      prompt: "Analyze auth module",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("completed");
    expect(result.planPath).toBeTruthy();
    await expect(readFile(result.logPath ?? "", "utf8")).resolves.toContain("received prompt");
  });

  it("reuses the desktop bridge protocol for custom desktop agents", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-agents-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-custom-desktop-"));
    configureAgentRegistry(configRoot);
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const agent = await saveCustomAgent({
      name: "Local Desktop Agent",
      protocol: "desktop-bridge",
      appPath: "/definitely/not/LocalAgent.app",
      bridgeInstructions: "Return a concise response.",
      capabilities: ["artifact-analysis", "implementation-plan"],
      description: "Test desktop bridge adapter."
    });

    const projectId = await registerProject(projectPath);
    const result = await startToolPlan({
      projectId,
      toolId: agent.id,
      prompt: "Analyze architecture",
      executionMode: "plan",
      purpose: "artifact-analysis"
    });

    expect(result.status).toBe("pending");
    const bridgeRequestPath = join(projectPath, FLOWWEAVE_DIR, "agent-bridge", result.id, "request.json");
    const bridgeInstructionsPath = join(projectPath, FLOWWEAVE_DIR, "agent-bridge", result.id, "instructions.md");
    await expect(readFile(bridgeRequestPath, "utf8")).resolves.toContain('"agentId": "custom:local-desktop-agent"');
    await expect(readFile(bridgeInstructionsPath, "utf8")).resolves.toContain("Return a concise response.");
  });
});

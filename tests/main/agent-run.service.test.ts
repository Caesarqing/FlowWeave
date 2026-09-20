import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { buildRunPrompt, startToolPlan } from "../../src/main/services/agent-run.service";
import { registerProject } from "../../src/main/services/project-registry.service";
import { listRunSummaries, readRunArtifact } from "../../src/main/services/run-log.service";
import { enableProjectAgentConnection } from "../../src/main/services/project-agent-connection.service";
import { createNodeCliFixture } from "./test-cli-fixture";

describe("agent-run.service", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
  });

  it("does not append implementation-plan instructions to artifact analysis prompts", () => {
    expect(buildRunPrompt("Return architecture JSON.", "plan", "artifact-analysis")).toBe("Return architecture JSON.");
    expect(buildRunPrompt("Implement auth.", "execute", "implementation-plan")).toBe("Implement auth.");
    expect(buildRunPrompt("Review auth.", "plan", "implementation-plan")).toContain("Do not edit files.");
  });

  it("generates prompt, plan, log, and result files with the mock tool", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);

    const result = await startToolPlan({
      projectId,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("completed");
    expect(result.executionMode).toBe("plan");
    await expect(readFile(result.promptPath ?? "", "utf8")).resolves.toContain("Review auth module.");
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("Mock plan");
    await expect(readFile(result.logPath ?? "", "utf8")).resolves.toContain("Plan generated");
    await expect(readFile(result.resultPath ?? "", "utf8")).resolves.toContain('"toolId": "mock"');
  });

  it("assigns isolated UUID run IDs to concurrent plans", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-concurrent-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);

    const [first, second] = await Promise.all([
      startToolPlan({
        projectId,
        toolId: "mock",
        prompt: "Review the first module.",
        executionMode: "plan",
        purpose: "implementation-plan"
      }),
      startToolPlan({
        projectId,
        toolId: "mock",
        prompt: "Review the second module.",
        executionMode: "plan",
        purpose: "implementation-plan"
      })
    ]);

    expect(first.id).toMatch(/^run-[a-f0-9-]{36}$/);
    expect(second.id).toMatch(/^run-[a-f0-9-]{36}$/);
    expect(first.id).not.toBe(second.id);
    await expect(readFile(first.resultPath ?? "", "utf8")).resolves.toContain('"toolId": "mock"');
    await expect(readFile(second.resultPath ?? "", "utf8")).resolves.toContain('"toolId": "mock"');
  });

  it("does not run model probes during CLI run preflight", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-codex-no-probe-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    await createNodeCliFixture(binDir, "codex", [
      "if (process.argv.includes('--version')) { console.log('codex-test 1.0'); process.exit(0); }",
      "if (process.argv[2] === 'exec' && process.argv.includes('--help')) {",
      "  console.log('Usage: codex exec [OPTIONS] [PROMPT]');",
      "  console.log('--cd <DIR> --sandbox <MODE> --output-last-message <FILE> stdin');",
      "  process.exit(0);",
      "}",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (input.includes('FlowWeave health check')) { console.error('unexpected model probe'); process.exit(7); }",
      "  const fs = require('fs');",
      "  const requestPath = input.match(/Read the request JSON at: (.+)/)?.[1];",
      "  if (!requestPath) throw new Error('Missing Agent Inbox request path.');",
      "  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
      "  fs.writeFileSync(request.responsePath, JSON.stringify({",
      "    protocolVersion: 2,",
      "    runId: request.runId,",
      "    projectId: request.projectId,",
      "    status: 'completed',",
      "    summary: 'codex inbox response',",
      "    content: '# Codex Plan',",
      "    completedAt: '2026-06-09T12:00:00.000Z'",
      "  }));",
      "  console.log('stdout log only');",
      "});"
    ].join("\n"), process.platform);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = await startToolPlan({
      projectId,
      toolId: "codex-local",
      prompt: "Review auth module.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("completed");
    expect(result.agentReadiness?.checks.some((check) => check.id === "codex-model-probe")).toBe(false);
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("Codex Plan");
  });

  it("refreshes stale enabled Agent context before spawning a CLI run", async () => {
    const projectPath = await createProjectWithConnection();
    const projectId = await registerProject(projectPath);
    const contextPath = join(projectPath, FLOWWEAVE_DIR, "agent-context.md");
    const context = await readFile(contextPath, "utf8");
    await writeFile(contextPath, context.replace(`Project root: ${projectPath}`, "Project root: /old/root"), "utf8");

    const result = await startToolPlan({
      projectId,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("completed");
    expect(result.agentReadiness?.refreshedConnection).toBe(true);
    await expect(readFile(contextPath, "utf8")).resolves.toContain(`Project root: ${await realpath(projectPath)}`);
  });

  it("blocks CLI runs when enabled Agent context cannot refresh", async () => {
    const projectPath = await createProjectWithConnection();
    const projectId = await registerProject(projectPath);
    await writeFile(join(projectPath, "AGENTS.md"), "<!-- flowweave:start -->\nBroken block\n", "utf8");

    const result = await startToolPlan({
      projectId,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("failed");
    expect(result.agentReadiness?.severity).toBe("error");
    expect(result.summary).toContain("Project Agent context");
    await expect(readFile(result.logPath ?? "", "utf8")).resolves.toContain("preflight failed");
  });

  it("writes Agent Inbox responses into run artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    setTimeout(() => {
      void readdir(join(projectPath, FLOWWEAVE_DIR, "runs")).then((runIds) => {
        const runId = runIds.find((id) => id.startsWith("run-"));
        if (!runId) throw new Error("Expected a run directory for the desktop response.");
        return mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true }).then(() =>
        writeFile(
          join(projectPath, ".flowweave", "runs", runId, "agent-response.json"),
          JSON.stringify({
            protocolVersion: 2,
            runId,
            projectId,
            status: "completed",
            summary: "desktop response",
            content: "# Desktop Run Plan",
            completedAt: "2026-06-09T12:00:00.000Z"
          }),
          "utf8"
        )
        );
      });
    }, 20);

    const result = await startToolPlan({
      projectId,
      toolId: "codex-desktop",
      prompt: "Review Agent Inbox.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const summaries = await listRunSummaries(projectPath);
    const artifact = await readRunArtifact(projectPath, result.id);
    expect(summaries[0].status).toBe("completed");
    expect(artifact.plan).toContain("Desktop Run Plan");
    expect(artifact.result).toContain('"toolId": "codex-desktop"');
  });

  it("imports Agent Inbox response.json for implementation-plan runs", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-md-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    setTimeout(() => {
      void readdir(join(projectPath, FLOWWEAVE_DIR, "runs")).then((runIds) => {
        const runId = runIds.find((id) => id.startsWith("run-"));
        if (!runId) throw new Error("Expected a run directory for the desktop response.");
        return mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true }).then(() =>
        writeFile(join(projectPath, ".flowweave", "runs", runId, "agent-response.json"), JSON.stringify({
          protocolVersion: 2,
          runId,
          projectId,
          status: "completed",
          summary: "desktop markdown response",
          content: "# Desktop Markdown Plan",
          completedAt: "2026-06-09T12:00:00.000Z"
        }), "utf8")
        );
      });
    }, 20);

    const result = await startToolPlan({
      projectId,
      toolId: "codex-desktop",
      prompt: "Review Agent Inbox markdown.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const artifact = await readRunArtifact(projectPath, result.id);
    expect(artifact.summary.status).toBe("completed");
    expect(artifact.plan).toContain("Desktop Markdown Plan");
  });
});

async function createProjectWithConnection() {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-connected-"));
  await mkdir(join(projectPath, FLOWWEAVE_DIR, "canvas"), { recursive: true });
  await mkdir(join(projectPath, FLOWWEAVE_DIR, "context"), { recursive: true });
  await mkdir(join(projectPath, FLOWWEAVE_DIR, "tasks"), { recursive: true });
  await writeFile(join(projectPath, FLOWWEAVE_DIR, "project.json"), JSON.stringify({
    version: 1,
    projectName: "Connected Project",
    rootPath: projectPath,
    generatedAt: new Date().toISOString(),
    git: { isRepo: true, branch: "main" },
    summary: { totalFiles: 0, totalFolders: 0, languages: {} },
    files: []
  }, null, 2), "utf8");
  await writeFile(join(projectPath, FLOWWEAVE_DIR, "context", "file-tree.md"), "# Project File Tree\n", "utf8");
  await enableProjectAgentConnection(projectPath);
  return projectPath;
}

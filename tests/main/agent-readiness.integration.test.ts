import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHealthCheckResult, RuntimeAgentId, ToolAdapter } from "../../src/types";
import { checkAgentReadiness } from "../../src/main/services/agent-readiness.service";
import { installBuiltInAgentPlugin } from "../../src/main/services/agent-plugin.service";
import { enableProjectAgentConnection } from "../../src/main/services/project-agent-connection.service";
import { writeEmptyProtocolFixture } from "./protocol.fixture";

const projectPaths: string[] = [];

afterEach(async () => {
  await Promise.all(projectPaths.splice(0).map((projectPath) => rm(projectPath, { recursive: true, force: true })));
});

describe("agent readiness host isolation with project files", () => {
  it("keeps Codex Desktop ready when only Gemini managed instructions are malformed", async () => {
    const projectPath = await createProject();
    await installBuiltInAgentPlugin(projectPath);
    await enableProjectAgentConnection(projectPath);
    await writeFile(join(projectPath, "GEMINI.md"), "<!-- flowweave:start -->\nBroken block\n", "utf8");

    const result = await checkAgentReadiness(desktopAdapter("codex-desktop"), {
      agentId: "codex-desktop",
      projectId: "project-codex",
      projectPath,
      adapterKind: "desktop",
      purpose: "implementation-plan",
      refreshConnection: true,
      runModelProbe: false
    });

    expect(result.severity).toBe("ok");
    expect(result.connection?.state).toBe("ready");
    expect(result.checks.find((check) => check.id === "project-agent-plugin-codex")?.status).toBe("passed");
  });

  it("reports Cursor ready in the same call that refreshes its missing managed rule", async () => {
    const projectPath = await createProject();
    await installBuiltInAgentPlugin(projectPath);
    await enableProjectAgentConnection(projectPath);
    const cursorRulePath = join(projectPath, ".cursor", "rules", "flowweave.mdc");
    await rm(cursorRulePath);

    const result = await checkAgentReadiness(desktopAdapter("cursor"), {
      agentId: "cursor",
      projectId: "project-cursor",
      projectPath,
      adapterKind: "desktop",
      purpose: "implementation-plan",
      refreshConnection: true,
      runModelProbe: false
    });

    expect(result.refreshedConnection).toBe(true);
    expect(result.severity).toBe("ok");
    expect(result.checks.find((check) => check.id === "project-agent-plugin-cursor")?.status).toBe("passed");
    expect((await stat(cursorRulePath)).isFile()).toBe(true);
  });
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-readiness-integration-"));
  projectPaths.push(projectPath);
  await writeEmptyProtocolFixture(projectPath, "readiness-scan");
  return projectPath;
}

function desktopAdapter(agentId: RuntimeAgentId): ToolAdapter {
  const health: AgentHealthCheckResult = {
    agentId,
    severity: "ok",
    checks: [{ id: "agent-command", label: "Agent command", status: "passed", message: `${agentId} is available.` }],
    suggestedActions: [],
    environmentHints: [],
    checkedAt: new Date().toISOString()
  };
  return {
    id: agentId,
    name: agentId,
    kind: "desktop",
    detect: async () => ({ toolId: agentId, available: true, method: "app" }),
    healthCheck: async () => health,
    runPlan: async () => {
      throw new Error("Run adapter is not used by readiness integration tests.");
    }
  };
}

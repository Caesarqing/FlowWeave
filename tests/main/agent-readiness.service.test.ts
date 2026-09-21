import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentPluginStatus,
  AgentReadinessResult,
  ProjectAgentConnectionStatus,
  ToolAdapter
} from "../../src/types";
import { checkAgentReadiness } from "../../src/main/services/agent-readiness.service";
import { getBuiltInAgentPluginStatuses } from "../../src/main/services/agent-plugin.service";
import {
  getProjectAgentConnectionForPlatform,
  refreshProjectAgentConnectionForPlatform
} from "../../src/main/services/project-agent-connection.service";

vi.mock("../../src/main/services/agent-plugin.service", () => ({
  getBuiltInAgentPluginStatuses: vi.fn()
}));
vi.mock("../../src/main/services/project-agent-connection.service", () => ({
  getProjectAgentConnectionForPlatform: vi.fn(),
  refreshProjectAgentConnectionForPlatform: vi.fn()
}));

const getStatusesMock = vi.mocked(getBuiltInAgentPluginStatuses);
const getConnectionMock = vi.mocked(getProjectAgentConnectionForPlatform);
const refreshConnectionMock = vi.mocked(refreshProjectAgentConnectionForPlatform);

describe("agent readiness plugin host selection", () => {
  beforeEach(() => {
    getStatusesMock.mockReset();
    getConnectionMock.mockReset();
    refreshConnectionMock.mockReset();
  });

  it("uses only the selected Agent host plugin status", async () => {
    getStatusesMock.mockResolvedValue([
      pluginStatus("gemini", "installed"),
      pluginStatus("codex", "missing", ["plugins/flowweave/.codex-plugin/plugin.json"]),
      pluginStatus("claude", "installed"),
      pluginStatus("cursor", "installed")
    ]);

    const result = await checkAgentReadiness(adapter("codex-local", "cli"), {
      agentId: "codex-local",
      projectId: "project-1",
      projectPath: "/tmp/flowweave-readiness-project",
      adapterKind: "cli",
      purpose: "implementation-plan",
      refreshConnection: false,
      runModelProbe: false
    });

    const pluginCheck = result.checks.find((check) => check.id === "project-agent-plugin-codex");
    expect(pluginCheck?.status).toBe("warning");
    expect(pluginCheck?.message).toContain("plugins/flowweave/.codex-plugin/plugin.json");
    expect(pluginCheck?.missingFiles).toEqual(["plugins/flowweave/.codex-plugin/plugin.json"]);
    expect(result.checks.some((check) => check.id === "project-agent-plugin-gemini")).toBe(false);
    expect(getConnectionMock).not.toHaveBeenCalled();
  });

  it("keeps an available CLI runnable when its matching host plugin is missing", async () => {
    getStatusesMock.mockResolvedValue([
      pluginStatus("codex", "missing", ["plugins/flowweave/.codex-plugin/plugin.json"]),
      pluginStatus("claude", "installed"),
      pluginStatus("gemini", "installed"),
      pluginStatus("cursor", "installed")
    ]);

    const result = await checkAgentReadiness(adapter("codex-local", "cli"), {
      agentId: "codex-local",
      projectId: "project-1",
      projectPath: "/tmp/flowweave-readiness-project",
      adapterKind: "cli",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      refreshConnection: true,
      runModelProbe: false
    });

    const pluginCheck = result.checks.find((check) => check.id === "project-agent-plugin-codex");
    expect(result.severity).toBe("warning");
    expect(pluginCheck?.status).toBe("warning");
    expect(pluginCheck?.blocking).toBe(false);
    expect(pluginCheck?.missingFiles).toEqual(["plugins/flowweave/.codex-plugin/plugin.json"]);
    expect(pluginCheck?.message).toContain("agentId=codex-local");
    expect(pluginCheck?.message).toContain("projectId=project-1");
    expect(result.suggestedActions.join(" ")).toContain("Install");
    expect(getConnectionMock).not.toHaveBeenCalled();
    expect(refreshConnectionMock).not.toHaveBeenCalled();
  });

  it("blocks a desktop Agent when its matching host plugin is missing", async () => {
    getStatusesMock.mockResolvedValue([
      pluginStatus("claude", "installed"),
      pluginStatus("codex", "missing", ["plugins/flowweave/.codex-plugin/plugin.json"]),
      pluginStatus("gemini", "installed"),
      pluginStatus("cursor", "installed")
    ]);
    getConnectionMock.mockResolvedValue(projectConnection("disabled", "/tmp/flowweave-readiness-project"));

    const result = await checkAgentReadiness(adapter("codex-desktop", "desktop"), {
      agentId: "codex-desktop",
      projectId: "project-1",
      projectPath: "/tmp/flowweave-readiness-project",
      adapterKind: "desktop",
      purpose: "implementation-plan",
      refreshConnection: true,
      runModelProbe: false
    });

    const pluginCheck = result.checks.find((check) => check.id === "project-agent-plugin-codex");
    const connectionCheck = result.checks.find((check) => check.id === "project-agent-connection");
    expect(result.severity).toBe("error");
    expect(pluginCheck?.status).toBe("failed");
    expect(pluginCheck?.blocking).toBe(true);
    expect(pluginCheck?.message).toContain("agentId=codex-desktop");
    expect(pluginCheck?.message).toContain("projectId=project-1");
    expect(pluginCheck?.missingFiles).toEqual(["plugins/flowweave/.codex-plugin/plugin.json"]);
    expect(connectionCheck?.status).toBe("failed");
    expect(connectionCheck?.missingFiles).toEqual([]);
    expect(connectionCheck?.suggestedActions?.join(" ").toLowerCase()).toContain("connect");
    expect(refreshConnectionMock).not.toHaveBeenCalled();
  });

  it("refreshes only desktop implementation-plan connections and keeps artifact analysis scoped", async () => {
    const readyStatuses = ["codex", "claude", "gemini", "cursor"] as const;
    getStatusesMock.mockResolvedValue(readyStatuses.map((hostId) => pluginStatus(hostId, "installed")));
    getConnectionMock
      .mockResolvedValueOnce(projectConnection("needs-refresh", "/tmp/flowweave-readiness-project"))
      .mockResolvedValueOnce(projectConnection("needs-refresh", "/tmp/flowweave-readiness-project"));
    refreshConnectionMock.mockResolvedValue(projectConnection("ready", "/tmp/flowweave-readiness-project"));

    const implementationPlan = await checkAgentReadiness(adapter("codex-desktop", "desktop"), {
      agentId: "codex-desktop",
      projectId: "project-1",
      projectPath: "/tmp/flowweave-readiness-project",
      adapterKind: "desktop",
      purpose: "implementation-plan",
      refreshConnection: true,
      runModelProbe: false
    });
    const artifactAnalysis = await checkAgentReadiness(adapter("codex-desktop", "desktop"), {
      agentId: "codex-desktop",
      projectId: "project-1",
      projectPath: "/tmp/flowweave-readiness-project",
      adapterKind: "desktop",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      refreshConnection: true,
      runModelProbe: false
    });

    expect(implementationPlan.refreshedConnection).toBe(true);
    expect(refreshConnectionMock).toHaveBeenCalledTimes(1);
    expect(artifactAnalysis.refreshedConnection).toBe(false);
    expect(artifactAnalysis.severity).toBe("warning");
    const artifactConnectionCheck = artifactAnalysis.checks.find((check) => check.id === "project-agent-connection");
    expect(artifactConnectionCheck?.status).toBe("warning");
    expect(artifactConnectionCheck?.blocking).toBe(false);
    expect(artifactConnectionCheck?.artifactTarget).toBe("architecture-map");
    expect(artifactConnectionCheck?.message).toContain("artifact-analysis");
  });

  it("checks Cursor plugin status after its project rule refresh completes", async () => {
    let connectionRefreshed = false;
    getConnectionMock.mockResolvedValue(projectConnection("needs-refresh", "/tmp/flowweave-readiness-project"));
    refreshConnectionMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      connectionRefreshed = true;
      return projectConnection("ready", "/tmp/flowweave-readiness-project");
    });
    getStatusesMock.mockImplementation(async () => [
      pluginStatus("cursor", connectionRefreshed ? "installed" : "missing", connectionRefreshed ? [] : [".cursor/rules/flowweave.mdc"])
    ]);

    const result = await checkAgentReadiness(adapter("cursor", "desktop"), {
      agentId: "cursor",
      projectId: "project-1",
      projectPath: "/tmp/flowweave-readiness-project",
      adapterKind: "desktop",
      purpose: "implementation-plan",
      refreshConnection: true,
      runModelProbe: false
    });

    expect(connectionRefreshed).toBe(true);
    expect(result.refreshedConnection).toBe(true);
    expect(result.severity).toBe("ok");
    expect(result.checks.find((check) => check.id === "project-agent-plugin-cursor")?.status).toBe("passed");
  });
});

function adapter(agentId: "codex-local" | "codex-desktop" | "cursor", kind: "cli" | "desktop"): ToolAdapter {
  const health: AgentReadinessResult = {
    agentId,
    severity: "ok",
    checks: [{ id: "agent-command", label: "Agent command", status: "passed", message: "Codex is available." }],
    suggestedActions: [],
    environmentHints: [],
    checkedAt: "2026-09-20T00:00:00.000Z"
  };
  return {
    id: agentId,
    name: kind === "cli" ? "Codex CLI" : `${agentId} Desktop`,
    kind,
    detect: async () => ({ toolId: agentId, available: true, method: kind === "cli" ? "cli" : "app" }),
    healthCheck: async () => health,
    runPlan: async () => {
      throw new Error("Run adapter is not used by readiness tests.");
    }
  };
}

function pluginStatus(
  hostId: AgentPluginStatus["hostId"],
  status: AgentPluginStatus["status"],
  missingFiles: string[] = []
): AgentPluginStatus {
  return {
    pluginId: "flowweave",
    hostId,
    displayName: hostId,
    status,
    bundledVersion: "0.2.0",
    installTarget: "/tmp/project/plugins/flowweave",
    requiredFiles: missingFiles,
    missingFiles,
    protocolVersion: 2,
    contentHash: `${hostId}-hash`,
    checks: missingFiles.length === 0
      ? [{ code: "host-ready", status: "passed", message: `${hostId} ready.` }]
      : [{ code: "native-manifest-missing", status: "failed", filePath: missingFiles[0], message: `${hostId} native manifest is missing.` }],
    suggestedActions: missingFiles.length === 0 ? [] : ["install"],
    message: missingFiles.length === 0 ? `${hostId} ready.` : `${hostId} is missing ${missingFiles[0]}.`
  };
}

function projectConnection(
  state: ProjectAgentConnectionStatus["state"],
  projectPath: string
): ProjectAgentConnectionStatus {
  return {
    state,
    enabled: state !== "disabled",
    needsConfirmation: state === "disabled",
    projectPath,
    contextPath: `${projectPath}/.flowweave/agent-context.md`,
    configPath: `${projectPath}/.flowweave/agent-connection.json`,
    generatedFiles: [],
    platforms: ["codex", "claude", "gemini", "cursor"],
    missingFiles: state === "needs-refresh" ? [`${projectPath}/.flowweave/agent-context.md`] : [],
    message: state
  };
}

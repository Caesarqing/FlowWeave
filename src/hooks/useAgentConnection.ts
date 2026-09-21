import { useEffect, useRef } from "react";
import { useAgentStore } from "../stores/agents.store";
import { useI18n } from "../utils/i18n";

export function useAgentConnection(projectId: string, projectPath: string) {
  const { t } = useI18n();
  const promptedProjects = useRef(new Set<string>());
  const requiresExternalContext = useAgentStore((state) =>
    state.agents.find((agent) => agent.id === state.selectedAgentId)?.kind === "desktop"
  );
  const connection = useAgentStore((state) => state.connection);
  const operation = useAgentStore((state) => state.connectionOperation);
  const setConnection = useAgentStore((state) => state.setConnection);
  const setOperation = useAgentStore((state) => state.setConnectionOperation);
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);

  async function load() {
    if (!window.flowweave || !projectId) {
      setConnection(undefined);
      return;
    }
    try {
      const status = await window.flowweave.getProjectAgentConnection(projectId);
      setConnection(status);
      if (!requiresExternalContext || !status.needsConfirmation || promptedProjects.current.has(projectId)) return;
      promptedProjects.current.add(projectId);
      const nextStatus = window.confirm(t("agent.connectionConfirm"))
        ? await window.flowweave.enableProjectAgentConnection(projectId)
        : await window.flowweave.disableProjectAgentConnection(projectId);
      setConnection(nextStatus);
      setLastRunStatus(nextStatus.message);
    } catch (error) {
      fail("agent.connectionLoadFailed", error);
    }
  }

  async function run(
    action: () => Promise<import("../types").ProjectAgentConnectionStatus>,
    errorKey: string
  ) {
    setOperation({ status: "running" });
    try {
      const status = await action();
      setConnection(status);
      setOperation({ status: "succeeded" });
      setLastRunStatus(status.message);
    } catch (error) {
      fail(errorKey, error);
    }
  }

  function fail(errorKey: string, error: unknown) {
    const message = t(errorKey, { error: formatErrorMessage(error) });
    setOperation({ status: "failed", error: message });
    setLastRunStatus(message);
    if (!connection && projectPath) {
      setConnection({
        state: "failed",
        enabled: false,
        needsConfirmation: false,
        projectPath,
        contextPath: `${projectPath}/.flowweave/agent-context.md`,
        configPath: `${projectPath}/.flowweave/agent-connection.json`,
        generatedFiles: [],
        platforms: ["codex", "claude", "gemini", "cursor"],
        message
      });
    }
  }

  useEffect(() => {
    void load();
  }, [projectId, requiresExternalContext]);

  return {
    connection,
    isBusy: operation.status === "running",
    connect: () => run(() => window.flowweave!.enableProjectAgentConnection(projectId), "agent.connectionEnableFailed"),
    disconnect: () => run(() => window.flowweave!.disableProjectAgentConnection(projectId), "agent.connectionDisableFailed"),
    refresh: () => run(() => window.flowweave!.refreshProjectAgentConnection(projectId), "agent.connectionRefreshFailed"),
    open: async () => {
      if (!window.flowweave || !projectId) return;
      try {
        await window.flowweave.openProjectAgentConnection(projectId);
      } catch (error) {
        fail("agent.connectionOpenFailed", error);
      }
    }
  };
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

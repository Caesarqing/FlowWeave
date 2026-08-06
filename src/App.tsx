import "@xyflow/react/dist/style.css";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { ModulePanel } from "./components/ModulePanel";
import { ProjectExplorer } from "./components/ProjectExplorer";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { UtilityPanels } from "./components/UtilityPanels";
import { useAppController } from "./hooks/useAppController";
import { useProjectWorkspaceTabs } from "./hooks/useProjectWorkspaceTabs";
import { usePreferencesStore } from "./stores/preferences.store";
import { lazy, Suspense, useEffect } from "react";
import { cn } from "./utils/classnames";
import { BrandLogo } from "./components/BrandLogo";
import { useI18n } from "./utils/i18n";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { ErrorCenter } from "./components/ErrorCenter";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { Button } from "./components/Button";
import { ProjectTabs } from "./components/ProjectTabs";
import { BrainCircuit, Link2, Plus } from "lucide-react";

const CanvasWorkspace = lazy(() => import("./components/CanvasWorkspace").then((module) => ({ default: module.CanvasWorkspace })));
const StructureWorkspace = lazy(() => import("./components/StructureWorkspace").then((module) => ({ default: module.StructureWorkspace })));
const DocumentWorkspace = lazy(() => import("./components/DocumentWorkspace").then((module) => ({ default: module.DocumentWorkspace })));
const GitReviewWorkspace = lazy(() => import("./components/GitReviewWorkspace").then((module) => ({ default: module.GitReviewWorkspace })));
const AgentPage = lazy(() => import("./components/AgentPage").then((module) => ({ default: module.AgentPage })));

export function App() {
  const reducedMotion = usePreferencesStore((state) => state.reducedMotion);
  const locale = usePreferencesStore((state) => state.locale);
  const theme = usePreferencesStore((state) => state.theme);
  const { t } = useI18n();

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    function applyTheme() {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.themeChoice = theme;
    }
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? "reduced" : "system";
  }, [reducedMotion]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  if (!window.flowweave) {
    return (
      <main className="desktop-only-shell">
        <section className="desktop-only-panel" aria-labelledby="desktop-only-title">
          <BrandLogo className="desktop-only-logo" />
          <div>
            <p className="desktop-only-kicker">FlowWeave Desktop</p>
            <h1 id="desktop-only-title">{t("desktopOnly.title")}</h1>
          </div>
          <p>{t("desktopOnly.body")}</p>
          <code>{t("desktopOnly.command")}</code>
          <span>{t("desktopOnly.help")}</span>
        </section>
      </main>
    );
  }

  return <DesktopApp />;
}

function DesktopApp() {
  const workspace = useProjectWorkspaceTabs();

  if (!workspace.isReady) {
    return <main className="workspace-page" aria-busy="true" />;
  }

  return <WorkspaceApp key={workspace.activeProjectId ?? "home"} workspace={workspace} />;
}

function WorkspaceApp({ workspace }: { workspace: ReturnType<typeof useProjectWorkspaceTabs> }) {
  const app = useAppController({
    onProjectOpenStarted: workspace.handleProjectOpenStarted,
    onProjectOpened: workspace.handleProjectOpened,
    restoreProjectId: workspace.restoreProjectId
  });
  const { t } = useI18n();
  const setUtilityPanel = usePreferencesStore((state) => state.setUtilityPanel);
  const utilityPanel = usePreferencesStore((state) => state.utilityPanel);

  function changePage(page: Parameters<typeof app.onPageChange>[0]) {
    setUtilityPanel(undefined);
    app.onPageChange(page);
  }

  return (
    <div className="app-shell">
      <OnboardingDialog />
      <ErrorCenter />
      <Sidebar activePage={app.activePage} activeUtilityPanel={utilityPanel} onPageChange={changePage} onUtilityPanelChange={setUtilityPanel} />
      <UtilityPanels activePanel={utilityPanel} onClose={() => setUtilityPanel(undefined)} projectId={app.projectId} />
      <section className="main-shell">
        <TopBar
          activePage={app.activePage}
          onExport={app.onExport}
          onSendToTool={app.onSendToTool}
          projectLabel={app.projectLabel}
          sendDisabled={!app.hasPendingModifications}
        />
        <ProjectTabs
          activeProjectId={workspace.activeProjectId}
          activeProjectStatus={{
            architectureReview: app.architectureReview,
            isProjectLoading: app.canvas.isProjectLoading,
            onRefreshProject: () => void app.canvas.onRefreshProject(),
            onUpdateArchitecture: () => void app.canvas.onAnalyzeProject(),
            onUpdateSequences: () => void app.sequence.generateDiagrams(),
            sequenceReview: app.sequence.review,
            statuses: app.artifactStatuses
          }}
          projects={workspace.openProjects}
          onActivate={workspace.activateProject}
          onClose={workspace.closeProject}
          onOpenProject={app.canvas.onOpenProject}
        />
        {workspace.workspaceError ? <p className="workspace-session-error" role="alert">{workspace.workspaceError}</p> : null}
        <div className="workspace-host">
        <Suspense fallback={<main className="workspace-page" aria-busy="true" />}>
        {app.activePage === "canvas" ? (
          <WorkspaceLayout
            className={cn("canvas-page", app.canvas.selectedNode || app.canvas.connectionPanelMode ? "has-selection" : "no-selection")}
            page="canvas"
            left={<ProjectExplorer
              expandedPaths={app.canvas.expandedPaths}
              files={app.canvas.projectFiles}
              isDesktopBridgeAvailable={app.isDesktopBridgeAvailable}
              isProjectLoading={app.canvas.isProjectLoading}
              maxVisibleRows={app.canvas.maxRenderedTreeRows}
              onOpenProject={app.canvas.onOpenProject}
              onRefreshProject={app.canvas.onRefreshProject}
              onCancelOperation={app.canvas.onCancelProjectOperation}
              onTogglePath={app.canvas.onTogglePath}
              projectPath={app.canvas.projectPath}
              statusMessage={app.canvas.projectStatus}
            />}
            right={app.canvas.connectionPanelMode ? (
              <ConnectionPanel
                defaultRelation={app.canvas.defaultRelation}
                mode={app.canvas.connectionPanelMode}
                modules={app.canvas.modules}
                onClose={app.canvas.onClearConnectionSelection}
                onCreateConnection={app.canvas.onAddConnection}
                onDeleteEdge={app.canvas.deleteEdge}
                onUpdateEdgeEndpoints={app.canvas.onUpdateEdgeEndpoints}
                onUpdateEdgeGuidance={app.canvas.onUpdateEdgeGuidance}
                onUpdateEdgeRelation={app.canvas.onUpdateEdgeRelation}
                selectedEdge={app.canvas.selectedEdge}
              />
            ) : app.canvas.selectedNode ? (
              <ModulePanel
                edges={app.canvas.graphRelations}
                guidanceOperation={app.canvas.guidanceOperation}
                node={app.canvas.selectedNode}
                onDeleteNode={app.canvas.deleteModuleNode}
                onGuidanceChange={app.canvas.onGuidanceChange}
                onModuleChange={app.canvas.onUpdateModuleFields}
                onSaveGuidance={app.canvas.onSaveGuidance}
                onSendGuidance={app.canvas.onSendGuidance}
                sendGuidanceDisabled={!app.canvas.hasPendingGuidance}
              />
            ) : undefined}
            rightAttention={Boolean(app.canvas.selectedNode || app.canvas.connectionPanelMode)}
            actions={(
              <>
                <Button
                  disabled={app.canvas.isProjectLoading}
                  icon={<BrainCircuit size={15} />}
                  label={app.canvas.isProjectLoading ? t("canvas.analyzing") : t("canvas.generate")}
                  size="default"
                  variant="primary"
                  onClick={app.canvas.onAnalyzeProject}
                >
                  <span className="workspace-action-label">
                    {app.canvas.isProjectLoading ? t("canvas.analyzing") : t("canvas.generate")}
                  </span>
                </Button>
                <Button icon={<Plus size={15} />} label={t("canvas.addNode")} variant="secondary" onClick={app.canvas.onAddNode}>
                  <span className="workspace-action-label">{t("canvas.addNode")}</span>
                </Button>
                <Button icon={<Link2 size={15} />} label={t("canvas.addConnection")} variant="secondary" onClick={app.canvas.onOpenConnectionCreator}>
                  <span className="workspace-action-label">{t("canvas.addConnection")}</span>
                </Button>
              </>
            )}
            status={app.canvas.analysisLabel}
            title={t("canvas.title")}
          >
            <CanvasWorkspace
              canvasLayout={app.canvas.canvasLayout}
              edges={app.canvas.edges}
              nodes={app.canvas.nodes}
              onConnect={app.canvas.onConnect}
              onApplyAutoLayout={app.canvas.onApplyAutoLayout}
              onEdgesChange={app.canvas.onEdgesChange}
              onNodesChange={app.canvas.onNodesChange}
              onOpenProject={app.canvas.onOpenProject}
              onRestoreManualLayout={app.canvas.onRestoreManualLayout}
              onPaneClick={app.canvas.onClearConnectionSelection}
              onSelectEdge={app.canvas.onSelectEdge}
              onSelectNode={app.canvas.onSelectNode}
              onSetCollapsedGroups={app.canvas.onSetCollapsedGroups}
            />
          </WorkspaceLayout>
        ) : app.activePage === "structure" ? (
          <StructureWorkspace sequence={app.sequence} />
          ) : app.activePage === "docs" ? (
          <DocumentWorkspace projectId={app.projectId} />
        ) : app.activePage === "git-review" ? (
          <GitReviewWorkspace projectId={app.projectId} />
        ) : (
          <AgentPage
            agents={app.tools.agents}
            architectureReview={app.tools.architectureReview}
            executionMode={app.tools.executionMode}
            isDesktopBridgeAvailable={app.isDesktopBridgeAvailable}
            lastRunStatus={app.tools.lastRunStatus}
            isRunsLoading={app.tools.isRunsLoading}
            onAnalyzeCurrentProject={app.tools.onAnalyzeCurrentProject}
            onApplyRunArtifact={app.tools.onApplyRunArtifact}
            onDeleteCustomAgent={app.tools.onDeleteCustomAgent}
            onDetectAgent={app.tools.onDetectAgent}
            onExecutionModeChange={app.tools.onExecutionModeChange}
            onGoToGitReview={app.tools.onGoToGitReview}
            onHealthCheckAgent={app.tools.onHealthCheckAgent}
            onInstallAgentPlugins={app.tools.onInstallAgentPlugins}
            onOpenAgentPluginFolder={app.tools.onOpenAgentPluginFolder}
            onOpenAgentPluginInstructions={app.tools.onOpenAgentPluginInstructions}
            onOpenRunBridge={app.tools.onOpenRunBridge}
            onOpenToolProject={app.tools.onOpenToolProject}
            onRefreshAgentPlugins={app.tools.onRefreshAgentPlugins}
            onRefreshRuns={app.tools.onRefreshRuns}
            onRetryRunArtifact={app.tools.onRetryRunArtifact}
            onRunToolPlan={app.tools.onRunToolPlan}
            onRunArtifactTabChange={app.tools.onRunArtifactTabChange}
            onSaveCustomAgent={app.tools.onSaveCustomAgent}
            onSelectRun={app.tools.onSelectRun}
            onSelectAgent={app.tools.onSelectAgent}
            projectConnection={app.agentConnection.connection}
            projectPath={app.canvas.projectPath}
            pluginStatuses={app.tools.pluginStatuses}
            runArtifactTab={app.tools.runArtifactTab}
            runs={app.tools.runs}
            selectedRunArtifact={app.tools.selectedRunArtifact}
            selectedRunId={app.tools.selectedRunId}
            selectedAgentId={app.tools.selectedAgentId}
            toolStatuses={app.tools.toolStatuses}
          />
        )}
        </Suspense>
        </div>
      </section>
    </div>
  );
}

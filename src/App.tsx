import "@xyflow/react/dist/style.css";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { DocumentWorkspace } from "./components/DocumentWorkspace";
import { GitReviewWorkspace } from "./components/GitReviewWorkspace";
import { ModulePanel } from "./components/ModulePanel";
import { ProjectExplorer } from "./components/ProjectExplorer";
import { Sidebar } from "./components/Sidebar";
import { StructureWorkspace } from "./components/StructureWorkspace";
import { AgentPage } from "./components/AgentPage";
import { TopBar } from "./components/TopBar";
import { UtilityPanels } from "./components/UtilityPanels";
import { useAppController } from "./hooks/useAppController";
import { usePreferencesStore } from "./stores/preferences.store";
import { useEffect } from "react";
import { cn } from "./utils/classnames";
import { BrandLogo } from "./components/BrandLogo";
import { useI18n } from "./utils/i18n";

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
  const app = useAppController();
  const setUtilityPanel = usePreferencesStore((state) => state.setUtilityPanel);
  const utilityPanel = usePreferencesStore((state) => state.utilityPanel);

  function changePage(page: Parameters<typeof app.onPageChange>[0]) {
    setUtilityPanel(undefined);
    app.onPageChange(page);
  }

  return (
    <div className="app-shell">
      <Sidebar activePage={app.activePage} activeUtilityPanel={utilityPanel} onPageChange={changePage} onUtilityPanelChange={setUtilityPanel} />
      <UtilityPanels activePanel={utilityPanel} onClose={() => setUtilityPanel(undefined)} />
      <section className="main-shell">
        <TopBar activePage={app.activePage} onExport={app.onExport} onSendToTool={app.onSendToTool} projectLabel={app.projectLabel} />
        {app.activePage === "canvas" ? (
          <div className={cn("canvas-page", app.canvas.selectedNode || app.canvas.connectionPanelMode ? "has-selection" : "no-selection")}>
            <ProjectExplorer
              expandedPaths={app.canvas.expandedPaths}
              files={app.canvas.projectFiles}
              isDesktopBridgeAvailable={app.isDesktopBridgeAvailable}
              isProjectLoading={app.canvas.isProjectLoading}
              maxVisibleRows={app.canvas.maxRenderedTreeRows}
              onOpenProject={app.canvas.onOpenProject}
              onRefreshProject={app.canvas.onRefreshProject}
              onTogglePath={app.canvas.onTogglePath}
              projectPath={app.canvas.projectPath}
              statusMessage={app.canvas.projectStatus}
            />
            <CanvasWorkspace
              analysisLabel={app.canvas.analysisLabel}
              edges={app.canvas.edges}
              isAnalyzing={app.canvas.isProjectLoading}
              nodes={app.canvas.nodes}
              onAddNode={app.canvas.onAddNode}
              onAnalyzeProject={app.canvas.onAnalyzeProject}
              onConnect={app.canvas.onConnect}
              onEdgesChange={app.canvas.onEdgesChange}
              onNodesChange={app.canvas.onNodesChange}
              onOpenProject={app.canvas.onOpenProject}
              onOpenConnectionCreator={app.canvas.onOpenConnectionCreator}
              onPaneClick={app.canvas.onClearConnectionSelection}
              onSelectEdge={app.canvas.onSelectEdge}
              onSelectNode={app.canvas.onSelectNode}
            />
            {app.canvas.connectionPanelMode ? (
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
                dialogText={app.dialogText}
                edges={app.canvas.graphRelations}
                node={app.canvas.selectedNode}
                onApplyDialog={app.canvas.onApplyDialog}
                onDeleteNode={app.canvas.deleteModuleNode}
                onDialogTextChange={app.canvas.onDialogTextChange}
                onGuidanceChange={app.canvas.onGuidanceChange}
                onModuleChange={app.canvas.onUpdateModuleFields}
                onWriteDraft={app.canvas.onWriteDraft}
              />
            ) : null}
          </div>
        ) : app.activePage === "structure" ? (
          <StructureWorkspace sequence={app.sequence} />
          ) : app.activePage === "docs" ? (
          <DocumentWorkspace projectPath={app.canvas.projectPath} />
        ) : app.activePage === "git-review" ? (
          <GitReviewWorkspace projectPath={app.canvas.projectPath} />
        ) : (
          <AgentPage
            agents={app.tools.agents}
            executionMode={app.tools.executionMode}
            isDesktopBridgeAvailable={app.isDesktopBridgeAvailable}
            lastRunStatus={app.tools.lastRunStatus}
            isRunsLoading={app.tools.isRunsLoading}
            onAnalyzeCurrentProject={app.tools.onAnalyzeCurrentProject}
            onDeleteCustomAgent={app.tools.onDeleteCustomAgent}
            onDetectAgent={app.tools.onDetectAgent}
            onExecutionModeChange={app.tools.onExecutionModeChange}
            onGoToGitReview={app.tools.onGoToGitReview}
            onOpenToolProject={app.tools.onOpenToolProject}
            onRefreshRuns={app.tools.onRefreshRuns}
            onRunToolPlan={app.tools.onRunToolPlan}
            onRunArtifactTabChange={app.tools.onRunArtifactTabChange}
            onSaveCustomAgent={app.tools.onSaveCustomAgent}
            onSelectRun={app.tools.onSelectRun}
            onSelectAgent={app.tools.onSelectAgent}
            projectPath={app.canvas.projectPath}
            runArtifactTab={app.tools.runArtifactTab}
            runs={app.tools.runs}
            selectedRunArtifact={app.tools.selectedRunArtifact}
            selectedRunId={app.tools.selectedRunId}
            selectedAgentId={app.tools.selectedAgentId}
            toolStatuses={app.tools.toolStatuses}
          />
        )}
      </section>
    </div>
  );
}

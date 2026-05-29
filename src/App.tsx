import "@xyflow/react/dist/style.css";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { DocumentWorkspace } from "./components/DocumentWorkspace";
import { GitReviewWorkspace } from "./components/GitReviewWorkspace";
import { ModulePanel } from "./components/ModulePanel";
import { ProjectExplorer } from "./components/ProjectExplorer";
import { Sidebar } from "./components/Sidebar";
import { StructureWorkspace } from "./components/StructureWorkspace";
import { AgentPage } from "./components/AgentPage";
import { TopBar } from "./components/TopBar";
import { useAppController } from "./hooks/useAppController";

export function App() {
  const app = useAppController();

  return (
    <div className="app-shell">
      <Sidebar activePage={app.activePage} onPageChange={app.onPageChange} />
      <section className="main-shell">
        <TopBar activePage={app.activePage} onExport={app.onExport} onSendToTool={app.onSendToTool} projectLabel={app.projectLabel} />
        {app.activePage === "canvas" ? (
          <div className={`canvas-page ${app.canvas.selectedNode ? "has-selection" : "no-selection"}`}>
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
              onSelectNode={app.canvas.onSelectNode}
            />
            {app.canvas.selectedNode ? (
              <ModulePanel
                dialogText={app.dialogText}
                edges={app.canvas.graphRelations}
                node={app.canvas.selectedNode}
                onApplyDialog={app.canvas.onApplyDialog}
                onDialogTextChange={app.canvas.onDialogTextChange}
                onGuidanceChange={app.canvas.onGuidanceChange}
                onWriteDraft={app.canvas.onWriteDraft}
              />
            ) : null}
          </div>
        ) : app.activePage === "structure" ? (
            <StructureWorkspace
              expandedPaths={app.canvas.expandedPaths}
              files={app.canvas.projectFiles}
              onTogglePath={app.canvas.onTogglePath}
              projectPath={app.canvas.projectPath}
            />
          ) : app.activePage === "docs" ? (
          <DocumentWorkspace projectPath={app.canvas.projectPath} />
        ) : app.activePage === "git-review" ? (
          <GitReviewWorkspace projectPath={app.canvas.projectPath} />
        ) : (
          <AgentPage
            executionMode={app.tools.executionMode}
            isDesktopBridgeAvailable={app.isDesktopBridgeAvailable}
            lastRunStatus={app.tools.lastRunStatus}
            onDetectTool={app.tools.onDetectTool}
            onExecutionModeChange={app.tools.onExecutionModeChange}
            onOpenToolProject={app.tools.onOpenToolProject}
            onRunToolPlan={app.tools.onRunToolPlan}
            onSelectTool={app.tools.onSelectTool}
            selectedToolId={app.tools.selectedToolId}
            toolStatuses={app.tools.toolStatuses}
          />
        )}
      </section>
    </div>
  );
}

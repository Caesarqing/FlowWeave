import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowWeaveProjectOpenResult, ProjectAnalysisCommittedResult, ProjectWorkspaceSession, RegisteredProject } from '../types';
import { closeProjectTab, addProjectTab } from '../utils/project-tabs';
import {
  captureProjectWorkspaceState,
  capturePersistedProjectWorkspaceContext,
  clearProjectWorkspaceState,
  restorePersistedProjectWorkspaceContext,
  restoreProjectWorkspaceState
} from '../stores/project-workspace-state';
import { useNavigationStore } from '../stores/navigation.store';
import { useProjectStore } from '../stores/project.store';
import { useCanvasStore } from '../stores/canvas.store';
import { useAgentStore } from '../stores/agents.store';
import { useRunsStore } from '../stores/runs.store';
import { useGitStore } from '../stores/git.store';

const EMPTY_SESSION: ProjectWorkspaceSession = {
  openProjectIds: [],
  lastPageByProject: {},
  contextsByProject: {}
};

type OpenProjectWorkspaceResult = ProjectAnalysisCommittedResult |
  Extract<FlowWeaveProjectOpenResult, { status: "analyzing" }>;

export function useProjectWorkspaceTabs() {
  const [isReady, setIsReady] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [session, setSession] = useState<ProjectWorkspaceSession>(EMPTY_SESSION);
  const [restoreProjectId, setRestoreProjectId] = useState<string>();
  const [pendingAnalysisProjectId, setPendingAnalysisProjectId] = useState<string>();
  const [pendingWorkspaceKey, setPendingWorkspaceKey] = useState<string>();
  const sessionRef = useRef<ProjectWorkspaceSession>(EMPTY_SESSION);
  const snapshots = useRef(new Map<string, ReturnType<typeof captureProjectWorkspaceState>>());
  const canvasFlush = useRef<(() => Promise<void>) | undefined>(undefined);
  const transitionSerial = useRef(0);
  const activePage = useNavigationStore((state) => state.activePage);
  const loadedProjectId = useProjectStore((state) => state.projectId);
  const expandedPaths = useCanvasStore((state) => state.expandedPaths);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const executionMode = useAgentStore((state) => state.executionMode);
  const selectedRunId = useRunsStore((state) => state.selectedRunId);
  const runArtifactTab = useRunsStore((state) => state.runArtifactTab);
  const checkpointId = useGitStore((state) => state.checkpointId);

  useEffect(() => {
    if (!window.flowweave) {
      setIsReady(true);
      return undefined;
    }
    let isMounted = true;
    void Promise.all([
      window.flowweave.listRegisteredProjects(),
      window.flowweave.readProjectWorkspaceSession()
    ]).then(([registeredProjects, savedSession]) => {
      if (!isMounted) return;
      restoreSavedPage(savedSession, savedSession.activeProjectId);
      sessionRef.current = savedSession;
      setProjects(registeredProjects);
      setSession(savedSession);
      setRestoreProjectId(savedSession.activeProjectId);
      setIsReady(true);
    }).catch((error) => {
      if (!isMounted) return;
      setWorkspaceError(formatWorkspaceError(error));
      setIsReady(true);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!isReady || !window.flowweave) return;
    void window.flowweave.saveProjectWorkspaceSession(session).catch((error) => {
      setWorkspaceError(formatWorkspaceError(error));
    });
  }, [isReady, session]);

  useEffect(() => {
    const current = sessionRef.current;
    const projectId = current.activeProjectId;
    if (!isReady || !projectId || loadedProjectId !== projectId) return;
    const context = capturePersistedProjectWorkspaceContext();
    if (current.lastPageByProject[projectId] === activePage && contextsEqual(current.contextsByProject[projectId], context)) return;
    updateSession({
      ...current,
      lastPageByProject: { ...current.lastPageByProject, [projectId]: activePage },
      contextsByProject: { ...current.contextsByProject, [projectId]: context }
    });
  }, [
    activePage,
    checkpointId,
    executionMode,
    expandedPaths,
    isReady,
    loadedProjectId,
    runArtifactTab,
    selectedAgentId,
    selectedNodeId,
    selectedRunId
  ]);

  const openProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    return session.openProjectIds.flatMap((projectId) => {
      const project = byId.get(projectId);
      return project ? [project] : [];
    });
  }, [projects, session.openProjectIds]);

  function updateSession(next: ProjectWorkspaceSession) {
    sessionRef.current = next;
    setSession(next);
  }

  function captureActiveWorkspace(): ProjectWorkspaceSession {
    const projectId = sessionRef.current.activeProjectId;
    if (!projectId || useProjectStore.getState().projectId !== projectId) return sessionRef.current;
    snapshots.current.set(projectId, captureProjectWorkspaceState());
    const next = {
      ...sessionRef.current,
      lastPageByProject: {
        ...sessionRef.current.lastPageByProject,
        [projectId]: useNavigationStore.getState().activePage
      },
      contextsByProject: {
        ...sessionRef.current.contextsByProject,
        [projectId]: capturePersistedProjectWorkspaceContext()
      }
    };
    updateSession(next);
    return next;
  }

  async function activateProject(projectId: string) {
    if (sessionRef.current.activeProjectId === projectId) return;
    const serial = ++transitionSerial.current;
    useProjectStore.getState().setIsCanvasTransitioning(true);
    try {
      if (!canvasFlush.current) throw new Error("Canvas save barrier is unavailable while switching projects.");
      await canvasFlush.current();
      if (serial !== transitionSerial.current) return;
      const current = captureActiveWorkspace();
      if (!current.openProjectIds.includes(projectId) || current.activeProjectId === projectId) return;
      if (current.activeProjectId && pendingAnalysisProjectId === current.activeProjectId) {
        void window.flowweave?.cancelProjectAnalysis(current.activeProjectId).catch((error) => {
          setWorkspaceError(formatWorkspaceError(error));
        });
        setPendingAnalysisProjectId(undefined);
        setPendingWorkspaceKey(undefined);
      }
      const snapshot = snapshots.current.get(projectId);
      if (snapshot) restoreProjectWorkspaceState(snapshot);
      else {
        clearProjectWorkspaceState();
        const context = current.contextsByProject[projectId];
        if (context) restorePersistedProjectWorkspaceContext(context);
        restoreSavedPage(current, projectId);
      }
      updateSession({ ...current, activeProjectId: projectId });
      setRestoreProjectId(snapshot ? undefined : projectId);
      setWorkspaceError(undefined);
    } catch (error) {
      if (serial === transitionSerial.current) setWorkspaceError(formatWorkspaceError(error));
    } finally {
      if (serial === transitionSerial.current) useProjectStore.getState().setIsCanvasTransitioning(false);
    }
  }

  async function closeProject(projectId: string) {
    const serial = ++transitionSerial.current;
    useProjectStore.getState().setIsCanvasTransitioning(true);
    try {
      if (sessionRef.current.activeProjectId === projectId) {
        if (!canvasFlush.current) throw new Error("Canvas save barrier is unavailable while closing a project.");
        await canvasFlush.current();
      }
      if (serial !== transitionSerial.current) return;
      const current = captureActiveWorkspace();
      if (!current.openProjectIds.includes(projectId)) return;
      if (pendingAnalysisProjectId === projectId) {
        void window.flowweave?.cancelProjectAnalysis(projectId).catch((error) => {
          setWorkspaceError(formatWorkspaceError(error));
        });
        setPendingAnalysisProjectId(undefined);
        setPendingWorkspaceKey(undefined);
      }
      snapshots.current.delete(projectId);
      const next = closeProjectTab(current, projectId);
      const nextProjectId = next.activeProjectId;
      if (current.activeProjectId === projectId) {
        const snapshot = nextProjectId ? snapshots.current.get(nextProjectId) : undefined;
        if (snapshot) restoreProjectWorkspaceState(snapshot);
        else {
          clearProjectWorkspaceState();
          const context = nextProjectId ? next.contextsByProject[nextProjectId] : undefined;
          if (context) restorePersistedProjectWorkspaceContext(context);
          restoreSavedPage(next, nextProjectId);
        }
        setRestoreProjectId(snapshot || !nextProjectId ? undefined : nextProjectId);
      }
      updateSession(next);
      setWorkspaceError(undefined);
    } catch (error) {
      if (serial === transitionSerial.current) setWorkspaceError(formatWorkspaceError(error));
    } finally {
      if (serial === transitionSerial.current) useProjectStore.getState().setIsCanvasTransitioning(false);
    }
  }

  function handleProjectOpenStarted() {
    captureActiveWorkspace();
  }

  function handleProjectOpened(result: OpenProjectWorkspaceResult) {
    const current = sessionRef.current;
    const projectId = result.projectId;
    const isAlreadyOpen = current.openProjectIds.includes(projectId);
    const existingSnapshot = snapshots.current.get(projectId);
    const project: RegisteredProject = {
      id: projectId,
      name: result.status === "analyzing" ? result.projectName : result.project.projectName,
      path: result.status === "analyzing" ? result.projectPath : result.project.rootPath,
      lastOpenedAt: new Date().toISOString()
    };
    setProjects((currentProjects) => [
      ...currentProjects.filter((item) => item.id !== projectId),
      project
    ]);
    if (result.status === "analyzing") {
      if (!pendingAnalysisProjectId) setPendingWorkspaceKey(current.activeProjectId ?? "home");
      setPendingAnalysisProjectId(projectId);
    } else if (pendingAnalysisProjectId === projectId) {
      setPendingAnalysisProjectId(undefined);
      setPendingWorkspaceKey(undefined);
    }

    if (result.status !== "analyzing") {
      if (isAlreadyOpen && current.activeProjectId !== projectId && existingSnapshot) {
        restoreProjectWorkspaceState(existingSnapshot);
      } else {
        snapshots.current.set(projectId, captureProjectWorkspaceState());
      }
    }
    const tabbedSession = addProjectTab(current, projectId);
    const next = {
      ...tabbedSession,
      contextsByProject: {
        ...tabbedSession.contextsByProject,
        [projectId]: capturePersistedProjectWorkspaceContext()
      }
    };
    updateSession(next);
    setRestoreProjectId(undefined);
  }

  function handleProjectAnalysisFinished(projectId: string) {
    if (pendingAnalysisProjectId !== projectId) return;
    setPendingAnalysisProjectId(undefined);
    setPendingWorkspaceKey(undefined);
  }

  return {
    setCanvasFlush: (flush: () => Promise<void>) => { canvasFlush.current = flush; },
    activeProjectId: session.activeProjectId,
    workspaceInstanceKey: pendingAnalysisProjectId === session.activeProjectId
      ? pendingWorkspaceKey ?? session.activeProjectId ?? "home"
      : session.activeProjectId ?? "home",
    closeProject,
    handleProjectAnalysisFinished,
    handleProjectOpened,
    handleProjectOpenStarted,
    isReady,
    openProjects,
    restoreProjectId,
    workspaceError,
    activateProject
  };
}

function formatWorkspaceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreSavedPage(session: ProjectWorkspaceSession, projectId: string | undefined): void {
  if (!projectId) return;
  useNavigationStore.getState().setActivePage(session.lastPageByProject[projectId] ?? 'canvas');
}

function contextsEqual(left: ProjectWorkspaceSession['contextsByProject'][string], right: ProjectWorkspaceSession['contextsByProject'][string]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

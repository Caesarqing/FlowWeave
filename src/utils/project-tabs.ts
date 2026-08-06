import type { ActivePage, ProjectWorkspaceContext } from "../types";

export type ProjectTabSession = {
  openProjectIds: string[];
  activeProjectId?: string;
  lastPageByProject: Partial<Record<string, ActivePage>>;
  contextsByProject: Partial<Record<string, ProjectWorkspaceContext>>;
};

export function addProjectTab(session: ProjectTabSession, projectId: string): ProjectTabSession {
  const openProjectIds = session.openProjectIds.includes(projectId)
    ? [...session.openProjectIds]
    : [...session.openProjectIds, projectId];
  return {
    openProjectIds,
    activeProjectId: projectId,
    lastPageByProject: {
      ...session.lastPageByProject,
      [projectId]: session.lastPageByProject[projectId] ?? "canvas"
    },
    contextsByProject: { ...session.contextsByProject }
  };
}

export function closeProjectTab(session: ProjectTabSession, projectId: string): ProjectTabSession {
  const closedIndex = session.openProjectIds.indexOf(projectId);
  if (closedIndex < 0) return copyProjectTabSession(session);
  const openProjectIds = session.openProjectIds.filter((id) => id !== projectId);
  const lastPageByProject = Object.fromEntries(
    Object.entries(session.lastPageByProject).filter(([id]) => id !== projectId)
  ) as Partial<Record<string, ActivePage>>;
  const contextsByProject = Object.fromEntries(
    Object.entries(session.contextsByProject).filter(([id]) => id !== projectId)
  ) as Partial<Record<string, ProjectWorkspaceContext>>;
  const activeProjectId = session.activeProjectId === projectId
    ? openProjectIds[closedIndex] ?? openProjectIds[closedIndex - 1]
    : session.activeProjectId;
  return { openProjectIds, activeProjectId, lastPageByProject, contextsByProject };
}

function copyProjectTabSession(session: ProjectTabSession): ProjectTabSession {
  return {
    openProjectIds: [...session.openProjectIds],
    activeProjectId: session.activeProjectId,
    lastPageByProject: { ...session.lastPageByProject },
    contextsByProject: { ...session.contextsByProject }
  };
}

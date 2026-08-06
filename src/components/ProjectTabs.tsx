import { FolderOpen, Plus, X } from 'lucide-react';
import type { RegisteredProject } from '../types';
import { useI18n } from '../utils/i18n';
import { ProjectStatusIndicator, type ActiveProjectStatus } from './ProjectStatusIndicator';

export function ProjectTabs({
  activeProjectId,
  activeProjectStatus,
  onActivate,
  onClose,
  onOpenProject,
  projects
}: {
  activeProjectId?: string;
  activeProjectStatus?: ActiveProjectStatus;
  onActivate: (projectId: string) => void;
  onClose: (projectId: string) => void;
  onOpenProject: () => void;
  projects: RegisteredProject[];
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('projectTabs.openProjects')} className="project-tab-bar">
      <div className="project-tab-list">
        {projects.map((project) => (
          <ProjectTab
            key={project.id}
            active={project.id === activeProjectId}
            activeProjectStatus={project.id === activeProjectId ? activeProjectStatus : undefined}
            project={project}
            onActivate={onActivate}
            onClose={onClose}
          />
        ))}
      </div>
      <button aria-label={t('projectTabs.openAnother')} className="project-tab-add" title={t('projectTabs.openAnother')} type="button" onClick={onOpenProject}>
        <Plus size={15} />
      </button>
    </nav>
  );
}

function ProjectTab({
  active,
  activeProjectStatus,
  onActivate,
  onClose,
  project
}: {
  active: boolean;
  activeProjectStatus?: ActiveProjectStatus;
  onActivate: (projectId: string) => void;
  onClose: (projectId: string) => void;
  project: RegisteredProject;
}) {
  const { t } = useI18n();
  const closeLabel = t('projectTabs.close', { project: project.name });
  return (
    <div className={active ? 'project-tab project-tab-active' : 'project-tab'}>
      <button
        aria-current={active ? 'page' : undefined}
        className="project-tab-select"
        title={project.path}
        type="button"
        onClick={() => onActivate(project.id)}
      >
        <FolderOpen size={14} />
        <span>{project.name}</span>
      </button>
      {activeProjectStatus ? <ProjectStatusIndicator {...activeProjectStatus} /> : null}
      <button
        aria-label={closeLabel}
        className="project-tab-close"
        title={closeLabel}
        type="button"
        onClick={() => onClose(project.id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

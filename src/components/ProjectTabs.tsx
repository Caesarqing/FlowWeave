import { FolderOpen, Plus, X } from 'lucide-react';
import type { RegisteredProject } from '../types';
import { useI18n } from '../utils/i18n';

export function ProjectTabs({
  activeProjectId,
  onActivate,
  onClose,
  onOpenProject,
  projects
}: {
  activeProjectId?: string;
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
  onActivate,
  onClose,
  project
}: {
  active: boolean;
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

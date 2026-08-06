import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectTabs } from '../../src/components/ProjectTabs';
import type { ActiveProjectStatus } from '../../src/components/ProjectStatusIndicator';
import type { RegisteredProject } from '../../src/types';
import { translate } from '../../src/utils/i18n';

describe('ProjectTabs component', () => {
  it('renders a single project in the same left-aligned tab strip used for multiple projects', () => {
    const project: RegisteredProject = {
      id: 'project-a',
      name: 'Project A',
      path: 'apps/project-a',
      addedAt: '2026-07-29T00:00:00.000Z',
      lastOpenedAt: '2026-07-29T00:00:00.000Z'
    };

    const markup = renderToStaticMarkup(
      React.createElement(ProjectTabs, {
        activeProjectId: project.id,
        onActivate: () => undefined,
        onClose: () => undefined,
        onOpenProject: () => undefined,
        projects: [project]
      })
    );

    expect(markup).toContain('aria-label="Open projects"');
    expect(markup).toContain('project-tab-list');
    expect(markup).not.toContain('project-tab-bar-single');
    expect(markup.indexOf('Project A')).toBeLessThan(markup.indexOf('Open another project'));
  });

  it('keeps the project tabs left-aligned and uses a single horizontal scroller', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const tabBarRule = findCssRule(css, '.project-tab-bar');
    const tabListRule = findCssRule(css, '.project-tab-list');

    expect(tabBarRule).toContain('justify-content: flex-start');
    expect(tabBarRule).toContain('overflow: hidden');
    expect(tabBarRule).not.toContain('overflow-x: auto');
    expect(tabListRule).toContain('overflow-x: auto');
    expect(tabListRule).toContain('max-width: calc(100% - 34px)');
  });

  it('hides the status text at the compact breakpoint while keeping the trigger visible', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const breakpointStart = css.indexOf('@media (max-width: 1040px)');
    const labelRuleStart = css.indexOf('.project-status-label', breakpointStart);
    const labelRuleEnd = css.indexOf('}', labelRuleStart);

    expect(breakpointStart).toBeGreaterThanOrEqual(0);
    expect(labelRuleStart).toBeGreaterThan(breakpointStart);
    expect(css.slice(labelRuleStart, labelRuleEnd)).toContain('display: none');
  });

  it('localizes project tab controls using the active locale', () => {
    expect(translate('zh-CN', 'projectTabs.openProjects')).toBe('已打开的项目');
    expect(translate('zh-CN', 'projectTabs.openAnother')).toBe('打开另一个项目');
    expect(translate('zh-CN', 'projectTabs.close', { project: '项目甲' })).toBe('关闭项目甲');
    expect(translate('zh-CN', 'projectStatus.ready')).toBe('正常');
    expect(translate('zh-CN', 'projectStatus.pending')).toBe('待生成');
    expect(translate('zh-CN', 'projectStatus.stale')).toBe('需更新');
  });

  it('renders the compact status entry only inside the active project tab', () => {
    const projects: RegisteredProject[] = [
      {
        id: 'project-a',
        name: 'Project A',
        path: 'apps/project-a',
        addedAt: '2026-07-29T00:00:00.000Z',
        lastOpenedAt: '2026-07-29T00:00:00.000Z'
      },
      {
        id: 'project-b',
        name: 'Project B',
        path: 'apps/project-b',
        addedAt: '2026-07-29T00:00:00.000Z',
        lastOpenedAt: '2026-07-29T00:00:00.000Z'
      }
    ];
    const activeProjectStatus: ActiveProjectStatus = {
      isProjectLoading: false,
      statuses: {
        project: 'current',
        canvas: 'current',
        task: 'current',
        context: 'current',
        architecture: 'current',
        sequences: 'current'
      },
      architectureReview: { state: 'local', scanFingerprint: 'scan-1' },
      sequenceReview: { state: 'local', scanFingerprint: 'scan-1' },
      onRefreshProject: () => undefined,
      onUpdateArchitecture: () => undefined,
      onUpdateSequences: () => undefined
    };

    const markup = renderToStaticMarkup(
      React.createElement(ProjectTabs, {
        activeProjectId: 'project-b',
        activeProjectStatus,
        onActivate: () => undefined,
        onClose: () => undefined,
        onOpenProject: () => undefined,
        projects
      })
    );

    expect(markup.match(/project-status-trigger/g)).toHaveLength(1);
    expect(markup.indexOf('Project B')).toBeLessThan(markup.indexOf('project-status-trigger'));
  });
});

function findCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  if (!match?.groups?.body) {
    throw new Error(`CSS rule ${selector} was not found.`);
  }
  return match.groups.body;
}

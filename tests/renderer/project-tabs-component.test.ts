import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectTabs } from '../../src/components/ProjectTabs';
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

  it('localizes project tab controls using the active locale', () => {
    expect(translate('zh-CN', 'projectTabs.openProjects')).toBe('已打开的项目');
    expect(translate('zh-CN', 'projectTabs.openAnother')).toBe('打开另一个项目');
    expect(translate('zh-CN', 'projectTabs.close', { project: '项目甲' })).toBe('关闭项目甲');
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

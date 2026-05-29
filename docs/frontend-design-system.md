# FlowWeave Frontend Design System

## Visual Direction

FlowWeave uses a restrained Linear/IDE-style dark workbench: deep gray panels, low-saturation blue accents, compact controls, and minimal decoration.

The UI must feel like a companion interface for local programming tools, not a standalone IDE or full programming system.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0b0f17` | App background |
| `--panel` | `#101620` | Panels |
| `--text` | `#e5e7eb` | Primary text |
| `--muted` | `#9ca3af` | Secondary text |
| `--accent` | `#7aa2f7` | Primary actions and selected state |
| `--success` | `#7dd3a8` | Ready/safe state |
| `--warning` | `#fbbf24` | Review state |
| `--danger` | `#fb7185` | Blocked/missing state |
| `--radius` | `8px` | Tool panels and controls |

## Components

- App shell: left narrow navigation with `Canvas` and `Tools`, compact top bar, and page-level content.
- Canvas page: project file tree, React Flow backend module graph, and selected module context panel.
- Tools page: Codex Local, Claude Code, Cursor, and Mock Tool cards with detection, plan generation, and project open controls.
- React Flow nodes: n8n-like module cards with input/output handles and low-saturation edge labels.
- Primary command: solid blue action for exporting guidance or starting dry run.
- Panels: flat dark surfaces with 1px gray-blue borders and compact labels.

## Interaction Rules

- Canvas must use `@xyflow/react` for dragging, pan/zoom, edges, MiniMap, and Controls.
- User edits in the canvas should produce `guidance.md` and `task.json`, including node connections.
- Tool output should produce project/module/document maps that populate structure, canvas, and document views.
- Avoid run logs, status bars, diff decks, and write-mode execute controls unless they are directly required for guiding the external tool.
- v1 tool actions generate plans only; write-mode execution is out of scope for the current product slice.
- Every command must have hover and keyboard focus states.
- Respect `prefers-reduced-motion`; glow and pulse should not be required to understand state.

## Accessibility

- Text contrast should target WCAG AA despite neon styling.
- Do not use color alone for state; pair color with labels such as `Healthy`, `Warning`, `Blocked`.
- Keep toolbar and panel text at deliberate sizes; no browser-default control typography.
- Avoid neon, gradients, and saturated multi-color UI so the app remains readable during long work sessions.

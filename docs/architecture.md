# FlowWeave Architecture

## Runtime Shape

FlowWeave uses Electron for local filesystem and process access, with React as the renderer UI.

- `src/main`: Electron main process, IPC, local services, and tool adapters.
- `src/preload`: secure bridge exposing a narrow `window.flowweave` API.
- `src/common`: IPC channel constants shared by main and preload.
- `src/App.tsx`: renderer workbench UI.
- `.flowweave`: per-project generated state and tool plan artifacts.

## Data Flow

1. User opens a project in the Electron UI.
2. `project.ipc.ts` calls `scanProject`.
3. `codeflow-store.ts` writes `.flowweave` project/canvas/task/context artifacts.
4. Renderer updates the file tree, project label, module nodes, and edges.
5. User adjusts module guidance on the canvas/context panel.
6. Tool plan generation starts through `agent.ipc.ts`.
7. `agent-run.service.ts` writes the prompt, runs the selected tool adapter, and stores logs/results/plan.

## Main Services

- `project-scanner.service.ts`: scans local files with default ignores, depth limits, and entry limits.
- `task-generator.service.ts`: builds canvas/task markdown/json artifacts from module nodes and relations.
- `agent-run.service.ts`: coordinates plan prompt creation, tool adapter execution, logs, plan, and result storage.
- `run-log.service.ts`: creates `.flowweave/runs/<run-id>/` and serializes tool events.

## Tool Adapters

- `ToolAdapter`: common interface for local tool detection, plan generation, and optional project opening.
- `CodexLocalAdapter`: wraps `codex exec` in read-only sandbox mode.
- `ClaudeCodeAdapter`: wraps Claude Code in plan mode.
- `CursorAdapter`: detects Cursor CLI/app, writes a manual review plan, and opens projects.
- `MockAgentAdapter`: deterministic local test adapter.

## Persistence

Each opened project can contain:

```txt
.flowweave/
├── project.json
├── canvas/main.canvas.json
├── context/file-tree.md
├── tasks/*.task.md
├── tasks/*.task.json
└── runs/<run-id>/
    ├── prompt.md
    ├── plan.md
    ├── agent.log
    └── result.json
```

## Verification

Core verification commands:

- `npm test`
- `npm run typecheck:node`
- `npm run build`
- `npm run build:electron`
- `npm run dist:dir`

# FlowWeave Architecture

## Runtime Shape

FlowWeave uses Electron for local filesystem and process access, with React as the renderer UI.

- `src/main`: Electron main process, IPC, local services, agent registry, and tool adapters.
- `src/preload`: secure bridge exposing a narrow `window.flowweave` API.
- `src/common`: IPC channel constants shared by main and preload.
- `src/App.tsx`: renderer workbench UI.
- `src/stores/workspace.store.ts`: unified renderer workspace state for project, canvas, tools, runs, Git review, and page navigation.
- `.flowweave`: per-project generated state and tool plan artifacts.

## Data Flow

1. User opens a project in the Electron UI.
2. `project.ipc.ts` calls `scanProject`.
3. `flowweave-store.ts` writes `.flowweave` project/canvas/task/context artifacts.
4. `structure-extractor.service.ts` can read code files and produce `ProjectStructureFacts`.
5. `agent-registry.service.ts` resolves the selected built-in or custom CLI Agent.
6. `architecture-analysis.service.ts` sends those facts to the selected Agent and normalizes the returned `ArchitectureMap`.
7. Renderer updates the file tree, architecture module nodes, relation edges, and right-panel detail evidence.
8. `sequence-diagram.service.ts` can ask the selected Agent for architectural and detailed-design sequence diagrams and persist them for the Structure page.
9. Tool plan generation starts through `agent.ipc.ts`.
10. `agent-run.service.ts` writes the prompt, runs the selected agent adapter, and stores logs/results/plan.
11. `run-log.service.ts` lists `.flowweave/runs/*` and reads fixed run artifacts for the Agent page.
12. Agent page can select a run, review prompt/plan/log/result, then jump to Git Review with that run context.

## Main Services

- `project-scanner.service.ts`: scans local files with default ignores, depth limits, and entry limits.
- `structure-extractor.service.ts`: extracts file-level imports, exports, symbols, calls, and external call hints across supported languages.
- `architecture-analysis.service.ts`: builds architecture prompts, parses Agent JSON, persists architecture maps, and converts maps into Canvas graphs.
- `sequence-diagram.service.ts`: builds sequence diagram prompts, parses Agent JSON, preserves existing diagrams on invalid output, and persists Structure page sequence artifacts.
- `task-generator.service.ts`: builds canvas/task markdown/json artifacts from module nodes and relations.
- `agent-registry.service.ts`: lists built-in Agents, persists custom CLI Agents in the Electron user data area, and resolves adapters.
- `agent-run.service.ts`: coordinates plan prompt creation, tool adapter execution, logs, plan, and result storage.
- `run-log.service.ts`: creates `.flowweave/runs/<run-id>/`, serializes tool events, lists run summaries, and reads fixed run artifacts.
- `git.service.ts`: reads Git status/diff, creates FlowWeave checkpoints, and restores explicit checkpoints.

## Tool Adapters

- `ToolAdapter`: common interface for local tool detection, plan generation, and optional project opening.
- `CodexLocalAdapter`: wraps `codex exec` in read-only sandbox mode.
- `ClaudeCodeAdapter`: wraps Claude Code in plan mode.
- `CursorAdapter`: detects Cursor CLI/app, writes a manual review plan, and opens projects.
- `CustomCliAdapter`: runs a user-configured local CLI command in the project directory and sends the prompt through stdin.
- `MockAgentAdapter`: deterministic local test adapter.

The mock adapter is retained for automated tests and development validation, but it is not shown as a normal user Agent card.

## Renderer Workspace State

`workspace.store.ts` owns the renderer state tree:

- `project`: active project label/path, loading state, and scan status.
- `canvas`: React Flow nodes/edges, inferred modules, selected node, project files, and expanded tree paths.
- `tools`: available Agents, selected default Agent, plan/execute mode, detection status, and last run status.
- `runs`: run summaries, selected run, selected artifact content, and artifact tab.
- `git`: active checkpoint, diff result, and safety state.

Older feature stores remain as compatibility files, but the workbench uses the unified workspace store for v0.2 flows.

## Architecture Canvas

The Canvas is no longer intended to show one node per folder. Its target graph is a functional architecture map:

- Nodes represent API boundaries, domain services, data access, external integrations, workers, utilities, and test surfaces.
- Edges represent module-level relationships such as calls, dependencies, reads/writes, external APIs, event publishing/subscription, and tests.
- The right module panel carries detail: file roles, key functions/classes, connection evidence, confidence, and editable guidance.
- Local extraction supplies stable structure facts. Agents supply semantic grouping, architecture style, module roles, and relationship explanations.

## Structure Sequence Diagrams

The Structure page is a sequence diagram workspace backed by `.flowweave/sequence-diagrams.json`:

- Architectural Sequence Diagram shows macro collaboration across apps, gateways, services, databases, workers, and third-party systems.
- Detailed Design Sequence Diagram maps to concrete controllers, classes, interfaces, repositories, and method calls.
- The left panel triggers manual generation or sends a revision instruction to the selected Agent.
- The center panel renders structured participants and messages without Mermaid.
- The right panel shows selected participant/message details, including method names, input, output, source file, symbol, and evidence.

## Persistence

Each opened project can contain:

```txt
.flowweave/
├── project.json
├── architecture-map.json
├── sequence-diagrams.json
├── file-insights.json
├── module-map.json
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

Run history is derived only from `.flowweave/runs/<run-id>/result.json`. Artifact reads are restricted to the fixed files above inside a safe run id directory.

## IPC Surface

The preload bridge exposes:

- `listAgents()`: returns built-in Agents plus custom CLI Agents from the local user config.
- `saveCustomAgent(input)`: saves a custom local CLI Agent for all projects.
- `deleteCustomAgent(agentId)`: removes a custom Agent. Built-ins are ignored.
- `detectAgent(agentId)`: detects a built-in or custom Agent.
- `listToolRuns(projectId)`: returns run summaries newest first.
- `readToolRun(projectId, runId)`: returns summary plus prompt, plan, log, and result text.
- `analyzeArchitecture(projectId, toolId)`: returns `generated | failed`; only validated results persist.
- `analyzeArchitectureWithAgent(projectId, agentId)`: same trusted architecture analysis path.
- `readArchitectureMap(projectId)`: reads the latest trusted architecture artifact.
- `generateSequenceDiagrams(projectId, agentId)`: returns `generated | cached | failed`; invalid output never writes a fallback bundle.
- `reviseSequenceDiagram(projectId, agentId, kind, instruction)`: revises one existing trusted diagram.
- `readSequenceDiagrams(projectId)`: reads the latest sequence bundle.

These APIs are local-only. Architecture analysis can call the selected local Agent in plan mode but does not ask FlowWeave to edit project files.

## Verification

Core verification commands:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run dist:dir`

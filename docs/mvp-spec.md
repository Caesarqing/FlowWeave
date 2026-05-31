# FlowWeave MVP Spec

## Goal

FlowWeave is a companion interface for local programming Agents. It reads a backend project, visualizes module context on a React Flow canvas, and generates guidance artifacts that Codex Local, Claude Code, Cursor, or user-defined local CLI Agents can use for human-reviewed implementation.

## Current MVP Capabilities

- Open and scan a local project from the Electron shell.
- Generate `.flowweave/project.json`, `.flowweave/canvas/main.canvas.json`, `.flowweave/context/file-tree.md`, and `.flowweave/tasks/*.task.md|json`.
- Display a restrained dark workbench with project file tree, architecture module canvas, selected module context, guidance editor, and Agent workbench.
- Connect architecture module nodes on the canvas; task artifacts include both nodes and relations.
- Detect Codex CLI, Claude Code CLI, Cursor CLI/Cursor.app, and custom local CLI Agent availability.
- Add custom CLI Agents with name, command, fixed args, and description. Custom Agent config is stored in the Electron user data area, not in the opened project.
- Generate local tool plans without FlowWeave directly editing project files.
- Store tool run artifacts in `.flowweave/runs/<run-id>/`.
- List previous tool runs and review prompt, plan, log, and result artifacts in the Agent page.
- Jump from a selected Agent run into Git Review while preserving the run/checkpoint context.
- Extract project structure facts from code files, including imports, exports, key functions/classes, calls, and external call hints.
- Generate a functional `ArchitectureMap` through local structure extraction plus Agent semantic grouping from either Canvas or the Agent page.

## v0.2 Capability Loop

The v0.2 workflow is architecture-to-review:

1. Open a local project and scan it into a module graph.
2. Select or add a default local Agent.
3. Generate an architecture graph with the selected local Agent from Canvas or Agent page.
4. Review functional modules, file roles, key functions, and connection evidence in the Canvas.
5. Edit module guidance and graph relations.
6. Send the selected module context to a local Agent in plan mode.
7. Review the generated run artifacts inside FlowWeave.
8. Move into Git Review to inspect any resulting diff and safety warnings.

FlowWeave remains plan-first. `execute` mode is still explicit and is not the primary v0.2 path.

## Architecture Canvas Output

FlowWeave persists architecture analysis into:

- `.flowweave/architecture-map.json`: functional modules, relationships, files, symbols, and evidence.
- `.flowweave/file-insights.json`: local structure facts extracted from project files.
- `.flowweave/module-map.json`: compatibility module map generated from the architecture map.

Canvas nodes are functional architecture modules, not folder names. File and function detail is shown in the right-side module panel.

## CLI Commands

- `npm run scan:project -- <path>` scans a project and writes `.flowweave` artifacts.
- `npm run tool:run -- --tool codex-local --check` checks Codex CLI availability.
- `npm run tool:run -- --tool claude-code --check` checks Claude Code CLI availability.
- `npm run tool:run -- --tool cursor --check` checks Cursor CLI/app availability.
- `npm run tool:run -- --tool mock --project <path> --prompt "..." --dry-run` validates the run pipeline.
- `npm run dist:dir` builds an unpacked Electron app directory.

## Agent Workbench

- Built-in Agents are Codex Local, Claude Code, and Cursor.
- `Mock Agent` is retained for tests and development validation but is not displayed as a normal user card.
- The selected default Agent is shown in a dedicated summary panel and highlighted in the card grid.
- The `+ 添加 Agent` card creates custom local CLI Agents. FlowWeave sends prompts through stdin and uses fixed startup args only.
- `分析当前项目并更新 Canvas` calls the same architecture analysis path as the Canvas action and persists `.flowweave/architecture-map.json`, `.flowweave/file-insights.json`, and `.flowweave/module-map.json`.

## Local Artifact APIs

- `listAgents()` returns built-in and custom Agents.
- `saveCustomAgent(input)` persists a custom CLI Agent in the local user config.
- `deleteCustomAgent(agentId)` removes a custom Agent.
- `detectAgent(agentId)` detects built-in and custom Agents.
- `listToolRuns(projectPath)` reads `.flowweave/runs/*/result.json` and returns summaries newest first.
- `readToolRun(projectPath, runId)` reads only fixed artifact files from `.flowweave/runs/<run-id>/`.
- Invalid run ids are rejected to prevent path traversal outside the run directory.
- `analyzeArchitecture(projectPath, toolId)` builds structure facts, asks the selected Agent for functional architecture grouping, and returns Canvas nodes/edges.
- `analyzeArchitectureWithAgent(projectPath, agentId)` is the Agent-id aware architecture analysis entry used by the Agent page.
- `readArchitectureMap(projectPath)` reads the latest persisted architecture analysis.

## Out Of Scope For This MVP Slice

- Full IDE editing.
- Cursor/VS Code extension integration.
- Cloud sync or multi-user collaboration.
- Direct write execution by Codex, Claude Code, or Cursor from FlowWeave.
- Remote PR diff import, patch accept/apply workflows, and automated rollback decisions.
- Direct Codex Cloud task execution.

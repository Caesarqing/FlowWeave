# FlowWeave MVP Spec

## Goal

FlowWeave is a companion interface for local programming tools. It reads a backend project, visualizes module context on a React Flow canvas, and generates guidance artifacts that Codex Local, Claude Code, or Cursor can use for human-reviewed implementation.

## Current MVP Capabilities

- Open and scan a local project from the Electron shell.
- Generate `.flowweave/project.json`, `.flowweave/canvas/main.canvas.json`, `.flowweave/context/file-tree.md`, and `.flowweave/tasks/*.task.md|json`.
- Display a restrained dark workbench with project file tree, backend module canvas, selected module context, guidance editor, and Tool Bridge.
- Connect module nodes on the canvas; task artifacts include both nodes and relations.
- Detect Codex CLI, Claude Code CLI, Cursor CLI, and Cursor.app availability.
- Generate local tool plans without FlowWeave directly editing project files.
- Store tool run artifacts in `.flowweave/runs/<run-id>/`.

## CLI Commands

- `npm run scan:project -- <path>` scans a project and writes `.flowweave` artifacts.
- `npm run tool:run -- --tool codex-local --check` checks Codex CLI availability.
- `npm run tool:run -- --tool claude-code --check` checks Claude Code CLI availability.
- `npm run tool:run -- --tool cursor --check` checks Cursor CLI/app availability.
- `npm run tool:run -- --tool mock --project <path> --prompt "..." --dry-run` validates the run pipeline.
- `npm run dist:dir` builds an unpacked Electron app directory.

## Out Of Scope For This MVP Slice

- Full IDE editing.
- Cursor/VS Code extension integration.
- Cloud sync or multi-user collaboration.
- Direct write execution by Codex, Claude Code, or Cursor from FlowWeave.
- Git review, patch import, accept, or rollback workflows.
- Direct Codex Cloud task execution.

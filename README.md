<p align="center">
  <img src="logo/flowweave-app-icon.png" alt="FlowWeave logo" width="112" />
</p>

<h1 align="center">FlowWeave</h1>

<p align="center">
  Understand your codebase, plan changes, and give AI agents focused context.
</p>

<p align="center">
  <a href="LICENSE.txt"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue" /></a>
  <img alt="Electron" src="https://img.shields.io/badge/Electron-42-47848f" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61dafb" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6" />
</p>

FlowWeave turns a local repository into an interactive map of its modules and relationships. Explore the project structure, trace connections to source evidence, organize your understanding, and prepare a focused task for an AI coding agent. Review the agent's plan and code changes in the same desktop app.

<p align="center">
  <a href="docs/video/FlowWeave-overview.mp4">▶ Watch the FlowWeave demo (3:27)</a>
</p>

## What you can do

- **Understand a project:** Explore a generated module map and inspect the files and static evidence behind its connections.
- **Plan a change:** Follow related modules, adjust the canvas layout, and add notes or sequence diagrams.
- **Guide an AI agent:** Give a configured agent relevant project context, then review its plan, output, and Git changes.
- **Keep work reviewable:** Inspect diffs and FlowWeave checkpoints before accepting changes or restoring a checkpoint.

## Quick start

### Requirements

- Node.js 22 and npm to run FlowWeave from source.
- Git for project status, checkpoints, and rollback.
- A local AI agent is optional; project scanning and graph exploration work without one.

### Run from source

```bash
git clone https://github.com/Caesarqing/FlowWeave.git
cd FlowWeave
npm ci
npm run dev
```

### Open your first project

1. Launch FlowWeave and open a local repository.
2. Wait for analysis to finish, then explore **Canvas** and select a module or connection to inspect its source evidence.
3. Use the other workspaces to document your findings, plan a change, or review your Git working tree.

## Workspaces

| Workspace | Use it to |
| --- | --- |
| **Canvas** | Explore modules and relationships, inspect source evidence, and organize the graph. |
| **Sequence** | Create and review architecture or detailed-design sequence diagrams. |
| **Docs** | Draft project documentation and keep task context with the project. |
| **Agents** | Check local agent integrations, prepare requests, and review runs. |
| **Git** | Inspect changes and diffs, and review FlowWeave checkpoints. |

## How it works

FlowWeave statically scans a project and groups source files into functional modules. It does not run the target project's application to discover runtime behavior. Detailed symbols and relationship evidence load when you select a graph item.

Deeper semantic analysis covers TypeScript and JavaScript, Vue, Python, Java, and Go. Other recognized file types may appear in the project tree with limited or no semantic relationship analysis. Static relationships are investigation leads; dynamic behavior, reflection, generated code, and runtime dispatch can leave gaps.

Canvas edits change FlowWeave's saved visual model and layout; they do not refactor source code. Use your editor or a configured agent to change implementation, then review the resulting Git diff.

## Project data and agent use

FlowWeave keeps project analysis, workspace state, and run records in `.flowweave/` at the root of each opened project. Analysis and FlowWeave records remain on your machine. If you use an external agent, its provider access, permissions, and data handling follow that agent's configuration.

## Development

```bash
npm run dev        # Start the desktop app
npm run typecheck  # Check TypeScript projects
npm test           # Run the test suite
npm run build      # Type-check and build the app
```

## License

FlowWeave is licensed under the GNU Affero General Public License v3.0. See [LICENSE.txt](LICENSE.txt).

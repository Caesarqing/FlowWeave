# FlowWeave for Codex

Use the `flowweave` skill when a project contains `.flowweave/agent-bridge`.

Codex Desktop and Codex CLI should read `.flowweave/agent-context.md`, process pending bridge requests, and write Agent Protocol v1 `response.json` files to each request's `responsePath`.

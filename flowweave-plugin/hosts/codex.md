# FlowWeave for Codex

Use the `flowweave` skill when a project contains `.flowweave/agent-inbox/current/request.json`.

Codex Desktop and Codex CLI should read `.flowweave/agent-context.md`, read the active Agent Inbox request, and write Agent Inbox v2 `response.json` to the request's `responsePath`.

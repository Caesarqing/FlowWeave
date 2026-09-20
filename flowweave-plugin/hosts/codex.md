# FlowWeave for Codex

Use the `flowweave` skill when FlowWeave provides a run-specific `.flowweave/runs/<run-id>/agent-request.json` path.

Codex Desktop and Codex CLI should read `.flowweave/agent-context.md`, read the run-specific Agent Inbox request, and write Agent Inbox v2 `agent-response.json` to the request's `responsePath`.

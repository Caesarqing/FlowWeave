# FlowWeave for Codex

Use the `flowweave` skill when FlowWeave provides a run-specific `.flowweave/runs/<run-id>/agent-request.json` path.

Codex Desktop and Codex CLI should read `.flowweave/agent-context.md`, read the exact run-specific `agent-request.json` path supplied by FlowWeave, and write one Agent Inbox v2 `agent-response.json` to the exact `responsePath` in that request.

# FlowWeave for Gemini

Gemini hosts should read `.flowweave/agent-context.md` and process the run-specific `.flowweave/runs/<run-id>/agent-request.json` path provided by FlowWeave when asked to use FlowWeave context.

Write Agent Inbox v2 `response.json` to the exact `responsePath` from the request.

---
name: flowweave
description: Process the active FlowWeave Agent Inbox v2 request when the user asks to use FlowWeave context or handle the current FlowWeave task.
---

# FlowWeave Agent Inbox v2

Use this skill only when FlowWeave provides a run-specific `.flowweave/runs/<run-id>/agent-request.json` path.

1. Read the exact run-specific `.flowweave/runs/<run-id>/agent-request.json` path provided by FlowWeave.
2. Verify that `request.projectPath` is the current project and do not access another project.
3. Read `.flowweave/agent-context.md`, then read only the artifacts explicitly needed by the request.
4. Follow `executionMode`:
   - `plan`: inspect only; do not modify project source files.
   - `execute`: modify only files inside the current project and run relevant verification.
5. Write exactly one Agent Inbox v2 response to the exact `request.responsePath`, using a temporary file followed by an atomic rename. Do not derive or substitute the response path.

The response filename is normally `agent-response.json`; the exact `responsePath` in the request is authoritative. Do not edit `.flowweave/architecture-review.json` or `.flowweave/sequence-review.json`. FlowWeave Core imports the response, validates it, and updates review state.

For `purpose: "artifact-analysis"`:

- The `content` field must contain the exact structured artifact JSON requested by `request.prompt`.
- Do not put an approval summary, markdown plan, or prose review in `content`.
- If you cannot produce the requested artifact JSON, use `status: "failed"` with an actionable `summary`, `content`, and `error.message`.

The response must have this shape:

```json
{
  "protocolVersion": 2,
  "runId": "request runId",
  "projectId": "request projectId",
  "status": "completed",
  "summary": "short result summary",
  "content": "full plan markdown or structured artifact JSON",
  "completedAt": "ISO-8601 timestamp"
}
```

Use `status: "failed"` when the request cannot be completed. Never fabricate a successful response.

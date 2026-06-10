---
name: flowweave
description: Process the newest pending FlowWeave Desktop bridge request when the user asks to use FlowWeave context or handle the current FlowWeave task.
---

# FlowWeave Desktop Bridge

Use this skill only inside a project containing `.flowweave/agent-bridge`.

1. Read `.flowweave/agent-context.md`.
2. Find the newest `.flowweave/agent-bridge/*/request.json` whose directory has no `response.json`.
3. Read the request's `promptPath` and `instructionsPath`.
4. Verify that `request.projectPath` is the current project and do not access another project.
5. Follow `executionMode`:
   - `plan`: inspect only; do not modify project files.
   - `execute`: modify only files inside the current project and run relevant verification.
6. Write `response.json` through a temporary file followed by an atomic rename.

The response must have this shape:

```json
{
  "runId": "request runId",
  "projectId": "request projectId",
  "status": "completed",
  "summary": "short result summary",
  "content": "full plan or implementation report",
  "completedAt": "ISO-8601 timestamp"
}
```

Use `status: "failed"` with an actionable `summary` and `content` when the request cannot be completed. Never fabricate a successful response.

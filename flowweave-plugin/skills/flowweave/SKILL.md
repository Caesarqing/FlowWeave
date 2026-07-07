---
name: flowweave
description: Process the newest pending FlowWeave Desktop bridge request when the user asks to use FlowWeave context or handle the current FlowWeave task.
---

# FlowWeave Agent Protocol v1 Desktop Bridge

Use this skill only inside a project containing `.flowweave/agent-bridge`.

1. Read `.flowweave/agent-context.md`.
2. Read `.flowweave/agent-bridge/pending-requests.json` and choose only entries with `"status": "pending"`.
3. Process pending entries from oldest `createdAt` to newest unless the user explicitly names a run id.
4. Read the request's `requestPath`, `promptPath`, and `instructionsPath`.
5. Verify that `request.projectPath` is the current project and do not access another project.
6. Follow `executionMode`:
   - `plan`: inspect only; do not modify project files.
   - `execute`: modify only files inside the current project and run relevant verification.
7. Write exactly one response to the request's `responsePath` through a temporary file followed by an atomic rename.

Do not edit `.flowweave/architecture-review.json` or `.flowweave/sequence-review.json`. FlowWeave Core imports `response.json`, validates it, and updates review state.

For `purpose: "artifact-analysis"`:

- `response.json` is required; do not write `response.md`.
- The `content` field must contain the exact structured artifact JSON requested by `promptPath`.
- Do not put an approval summary, markdown plan, or prose review in `content`.
- If you cannot produce the requested artifact JSON, use `status: "failed"` with an actionable `summary` and `content`.

For `purpose: "implementation-plan"`:

- `content` may contain a markdown plan or implementation report.
- `response.md` is accepted only for implementation-plan requests, but `response.json` is preferred.

The response must have this shape:

```json
{
  "protocolVersion": 1,
  "runId": "request runId",
  "projectId": "request projectId",
  "status": "completed",
  "summary": "short result summary",
  "content": "full plan or implementation report",
  "completedAt": "ISO-8601 timestamp"
}
```

Use `status: "failed"` with an actionable `summary` and `content` when the request cannot be completed. Never fabricate a successful response.

# FlowWeave CLI Agent Connection Repair Plan

Goal: make CLI Agent runs verify current FlowWeave project context, command availability, and failure classification before spawning Codex, Claude, Gemini, or custom CLI agents.

## Summary

- Add project-scoped readiness checks before Agent runs.
- Refresh enabled but stale FlowWeave Agent connection files before spawning an Agent.
- Block runs only when enabled connection refresh fails or the command is missing.
- Keep CLI runs allowed when external Agent connection is disabled because FlowWeave sends context through stdin.
- Surface readiness and connection state in run history and Agent cards.

## Key Changes

- Add `AgentReadinessResult` and attach it to `ToolRunResult` / `ToolRunSummary`.
- Add `src/main/services/agent-readiness.service.ts`.
- Make `healthCheckAgent(agentId, projectId?)` project-aware.
- Validate `.flowweave/agent-context.md` root and managed pending-request instructions.
- Remove recognized legacy `.flowweave/agent-connectors` generated artifacts on successful connection refresh.
- Add detailed Codex, Gemini, and custom CLI health checks.

## Test Plan

- Main tests cover stale context refresh, malformed marker blocking, disabled connection allowing CLI run, legacy cleanup, Codex/Gemini/custom CLI health checks, and provider failures staying provider failures.
- Renderer tests cover project-aware health check calls, readiness/status labels, connector prompt wording, and i18n alignment.
- Verification commands:
  - `npx vitest run tests/main/project-agent-connection.service.test.ts tests/main/agent-run.service.test.ts tests/main/codex-local.adapter.test.ts tests/main/gemini-cli.adapter.test.ts tests/main/agent-registry.service.test.ts`
  - `npx vitest run tests/renderer/agent-connector-prompts.test.ts tests/renderer/i18n.test.ts`
  - `npm run typecheck`
  - `npm test`
  - `npm run dist:dir`

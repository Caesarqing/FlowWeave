import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolAdapter } from "../src/types";
import { ClaudeCodeAdapter } from "../src/main/agents/claude-code.adapter";
import { CodexLocalAdapter } from "../src/main/agents/codex-local.adapter";
import { executeAgentWithPolicy } from "../src/main/services/agent-execution.service";

const EXPECTED_RESPONSE = "FLOWWEAVE_AGENT_SMOKE_OK";
const runId = `agent-smoke-${Date.now()}`;
const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-smoke-"));
const runPath = join(projectPath, ".flowweave", "runs", runId);
const agentId = process.env.FLOWWEAVE_SMOKE_AGENT ?? "codex-local";
process.env.FLOWWEAVE_AGENT_SMOKE_ISOLATED = "1";

try {
  await mkdir(runPath, { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# FlowWeave Agent Smoke Fixture\n", "utf8");
  const adapter = createAdapter(agentId);
  const detection = await adapter.detect();
  if (!detection.available) {
    throw new Error(`Codex Agent smoke test cannot run: ${detection.message}`);
  }

  const result = await executeAgentWithPolicy(adapter, {
    id: runId,
    projectId: "agent-smoke",
    projectPath,
    prompt: `Read README.md without changing any files. Return exactly ${EXPECTED_RESPONSE} and nothing else.`,
    executionMode: "plan",
    purpose: "implementation-plan"
  }, {
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
    retryCount: 0,
    retryDelayMs: 0
  });
  if (result.status !== "completed") {
    const details = result.events
      .filter((event) => event.type === "stderr" || event.type === "error")
      .map((event) => event.type === "stderr" ? event.content : event.message)
      .join("\n");
    throw new Error(
      `Codex Agent smoke test failed: termination=${result.terminationReason ?? "unknown"}, exit=${result.exitCode ?? "none"}\n${details}`
    );
  }
  const response = adapter.id === "codex-local"
    ? await readFile(join(runPath, "last-message.md"), "utf8")
    : result.events
      .filter((event) => event.type === "stdout")
      .map((event) => event.content)
      .join("\n");
  if (!response.includes(EXPECTED_RESPONSE)) {
    throw new Error(`${adapter.name} smoke test returned an unexpected response: ${response}`);
  }
  console.log(`FlowWeave real Agent smoke test passed with ${adapter.name} ${detection.version ?? "unknown version"}.`);
} finally {
  await rm(projectPath, { force: true, recursive: true });
}

function createAdapter(value: string): ToolAdapter {
  if (value === "codex-local") return new CodexLocalAdapter();
  if (value === "claude-code") return new ClaudeCodeAdapter();
  throw new Error(`Unsupported FlowWeave smoke Agent: ${value}`);
}

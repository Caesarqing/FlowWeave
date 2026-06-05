import { describe, expect, it } from "vitest";
import { buildAgentConnectorPrompt } from "../../src/utils/agent-connector-prompts";
import type { RuntimeAgentId } from "../../src/types";

describe("agent connector prompts", () => {
  it("builds connector prompts for every built-in Agent without creating a FlowWeave chat UI contract", () => {
    const ids: RuntimeAgentId[] = [
      "claude-code",
      "claude-desktop",
      "codex-local",
      "codex-desktop",
      "gemini-cli",
      "cursor"
    ];

    const prompts = ids.map((agentId) => buildAgentConnectorPrompt({ agentId, projectPath: "/tmp/project" }));

    expect(prompts.map((prompt) => prompt.connectorPath)).toEqual([
      "/tmp/project/.flowweave/agent-connectors/claude.md",
      "/tmp/project/.flowweave/agent-connectors/claude.md",
      "/tmp/project/.flowweave/agent-connectors/codex.md",
      "/tmp/project/.flowweave/agent-connectors/codex.md",
      "/tmp/project/.flowweave/agent-connectors/gemini.md",
      "/tmp/project/.flowweave/agent-connectors/cursor.md"
    ]);
    expect(prompts.every((prompt) => prompt.command.includes("You may modify project files directly."))).toBe(true);
  });
});

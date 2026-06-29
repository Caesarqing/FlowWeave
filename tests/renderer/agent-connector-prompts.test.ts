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

    const prompts = ids.map((agentId) => buildAgentConnectorPrompt({ agentId, locale: "en", projectPath: "/tmp/project" }));
    const chinesePrompts = ids.map((agentId) => buildAgentConnectorPrompt({ agentId, locale: "zh-CN", projectPath: "/tmp/project" }));

    expect(prompts.map((prompt) => prompt.connectorPath)).toEqual([
      "/tmp/project/.flowweave/agent-context.md",
      "/tmp/project/.flowweave/agent-context.md",
      "/tmp/project/.flowweave/agent-context.md",
      "/tmp/project/.flowweave/agent-context.md",
      "/tmp/project/.flowweave/agent-context.md",
      "/tmp/project/.flowweave/agent-context.md"
    ]);
    expect(prompts[1].command).toBe("Use FlowWeave context to process pending requests.");
    expect(prompts[3].command).toBe("Use FlowWeave context to process pending requests.");
    expect(prompts[0].description).toContain("stdin");
    expect(prompts[3].description).toContain("pending request");
    expect(prompts[1].command).not.toMatch(/[\u3400-\u9fff]/u);
    expect(chinesePrompts[1].command).toBe("使用 FlowWeave 上下文处理当前待办");
    expect(chinesePrompts[3].command).toBe("使用 FlowWeave 上下文处理当前待办");
    expect([prompts[0], prompts[2], prompts[4], prompts[5]].every((prompt) =>
      prompt.command.includes("You may modify project files directly.")
    )).toBe(true);
    expect(chinesePrompts[0].command).toContain("读取 /tmp/project/.flowweave/agent-context.md");
  });
});

import { describe, expect, it } from "vitest";
import { translate } from "../../src/utils/i18n";
import { localizeCanvasEdgeLabels } from "../../src/components/CanvasWorkspace";
import { useCanvasStore } from "../../src/stores/canvas.store";
import { useWorkspaceStore } from "../../src/stores/workspace.store";

describe("i18n translations", () => {
  it("keeps English UI copy in the English locale", () => {
    expect(translate("en", "canvas.title")).toBe("Backend Module Graph");
    expect(translate("en", "project.files")).toBe("Project Files");
    expect(translate("en", "structure.details")).toBe("Details & Agent");
    expect(translate("en", "structure.sourceFiles", { count: 3, messageCount: "2 messages" })).toBe("3 source files · Agent-ready · 2 messages");
    expect(translate("en", "relation.depends_onDescription")).toContain("depends on the target");
    expect(translate("en", "sequence.generated", { counts: "2 architectural messages, 4 detailed design messages" })).toBe(
      "Sequence diagram generated: 2 architectural messages, 4 detailed design messages."
    );
    expect(translate("en", "desktopOnly.title")).toBe("Open FlowWeave from the desktop app");
    expect(translate("en", "agent.bridgeWarning")).not.toContain("Browser preview");
    expect(translate("en", "agent.codexDescription")).toContain("local Codex CLI");
    expect(translate("en", "agent.claudeDesktopDescription")).toContain("agent-bridge");
    expect(translate("en", "agent.codexDesktopDescription")).toContain("response.json");
    expect(translate("en", "agent.geminiDescription")).toContain("Gemini CLI");
    expect(translate("en", "agent.connectorPrompt")).toBe("Connector prompt");
    expect(translate("en", "agent.copyConnector")).toBe("Copy connector");
    expect(translate("en", "module.manualSubtitle")).toBe("Manual module");
  });

  it("uses Simplified Chinese UI copy in the Chinese locale", () => {
    expect(translate("zh-CN", "canvas.title")).toBe("后端模块图");
    expect(translate("zh-CN", "project.files")).toBe("项目文件");
    expect(translate("zh-CN", "structure.emptyTitle")).toBe("尚未生成序列图");
    expect(translate("zh-CN", "structure.sourceFiles", { count: 3, messageCount: "2 条消息" })).toBe("3 个源文件 · 智能体就绪 · 2 条消息");
    expect(translate("zh-CN", "relation.depends_onDescription")).toContain("依赖目标模块");
    expect(translate("zh-CN", "sequence.generated", { counts: "2 条架构消息，4 条详细设计消息" })).toBe(
      "序列图生成完成：2 条架构消息，4 条详细设计消息。"
    );
    expect(translate("zh-CN", "desktopOnly.title")).toBe("请从桌面端打开 FlowWeave");
    expect(translate("zh-CN", "agent.bridgeWarning")).not.toContain("浏览器预览");
    expect(translate("zh-CN", "agent.codexDescription")).toContain("本地 Codex CLI");
    expect(translate("zh-CN", "agent.claudeDesktopDescription")).toContain("agent-bridge");
    expect(translate("zh-CN", "agent.codexDesktopDescription")).toContain("response.json");
    expect(translate("zh-CN", "agent.geminiDescription")).toContain("Gemini CLI");
    expect(translate("zh-CN", "agent.connectorPrompt")).toBe("连接提示");
    expect(translate("zh-CN", "agent.copyConnector")).toBe("复制连接");
    expect(translate("zh-CN", "module.manualSubtitle")).toBe("手动补充模块");
  });

  it("localizes Canvas relation labels on edges", () => {
    const [englishEdge] = localizeCanvasEdgeLabels(
      [{ id: "edge", source: "api", target: "service", data: { relation: "calls" } }],
      (key) => translate("en", key)
    );
    const [chineseEdge] = localizeCanvasEdgeLabels(
      [{ id: "edge", source: "api", target: "service", data: { relation: "calls" } }],
      (key) => translate("zh-CN", key)
    );

    expect(englishEdge.label).toBe("Calls");
    expect(chineseEdge.label).toBe("调用");
  });

  it("starts Canvas stores without a demo graph", () => {
    expect(useWorkspaceStore.getState().selectedAgentId).toBe("claude-code");
    expect(useWorkspaceStore.getState().nodes).toEqual([]);
    expect(useWorkspaceStore.getState().edges).toEqual([]);
    expect(useWorkspaceStore.getState().modules).toEqual([]);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useCanvasStore.getState().modules).toEqual([]);
  });
});

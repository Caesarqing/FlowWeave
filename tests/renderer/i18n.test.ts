import { describe, expect, it } from "vitest";
import { translate, translationMessages } from "../../src/utils/i18n";
import { localizeCanvasEdgeLabels } from "../../src/components/CanvasWorkspace";
import { useAgentStore } from "../../src/stores/agents.store";
import { useCanvasStore } from "../../src/stores/canvas.store";
import { DEFAULT_LOCALE } from "../../src/stores/preferences.store";
import type { GraphNode, SequenceDiagram } from "../../src/types";
import {
  localizedModuleDescription,
  localizedModuleGuidance
} from "../../src/utils/module-text";
import { localizedSequenceDiagram } from "../../src/utils/sequence-text";

describe("i18n translations", () => {
  it("keeps English UI copy in the English locale", () => {
    expect(translate("en", "canvas.title")).toBe("Module Graph");
    expect(translate("en", "project.files")).toBe("Project Files");
    expect(translate("en", "structure.details")).toBe("Details & Agent");
    expect(translate("en", "structure.sourceFiles", { count: 3, messageCount: "2 messages" })).toBe("3 source files · Agent-ready · 2 messages");
    expect(translate("en", "relation.depends_onDescription")).toContain("depends on the target");
    expect(translate("en", "sequence.generated", { counts: "2 architectural messages" })).toBe(
      "Sequence diagram generated: 2 architectural messages."
    );
    expect(translate("en", "desktopOnly.title")).toBe("Open FlowWeave from the desktop app");
    expect(translate("en", "agent.bridgeWarning")).not.toContain("Browser preview");
    expect(translate("en", "agent.codexDescription")).toContain("local Codex CLI");
    expect(translate("en", "agent.claudeDesktopDescription")).toContain("agent-bridge");
    expect(translate("en", "agent.codexDesktopDescription")).toContain("response.json");
    expect(translate("en", "agent.geminiDescription")).toContain("Gemini CLI");
    expect(translate("en", "agent.healthCheck")).toBe("Health check");
    expect(translate("en", "agent.connectorPrompt")).toBe("Connector prompt");
    expect(translate("en", "agent.copyConnector")).toBe("Copy connector");
    expect(translate("en", "agent.protocolCli")).toBe("CLI stdin");
    expect(translate("en", "agent.protocolDesktop")).toBe("Desktop bridge");
    expect(translate("en", "agent.capabilityArtifactAnalysis")).toBe("Artifact analysis");
    expect(translate("en", "module.manualSubtitle")).toBe("Manual module");
    expect(translate("en", "assessment.high")).toBe("high");
    expect(translate("en", "settings.planTimeout")).toContain("Plan timeout");
    expect(translate("en", "module.riskOverridePrompt")).toContain("overridden");
    expect(translate("en", "artifact.state.stale")).toBe("Outdated");
    expect(translate("en", "artifact.sequences")).toBe("Architectural sequence diagram");
    expect(translate("en", "onboarding.title")).toContain("Understand the project");
    expect(translate("en", "settings.executeTimeout")).toContain("minutes");
    expect(translate("en", "settings.scanBudget")).toBe("Scan entry budget");
  });

  it("uses Simplified Chinese UI copy in the Chinese locale", () => {
    expect(translate("zh-CN", "canvas.title")).toBe("模块图");
    expect(translate("zh-CN", "project.files")).toBe("项目文件");
    expect(translate("zh-CN", "structure.emptyTitle")).toBe("尚未生成序列图");
    expect(translate("zh-CN", "structure.sourceFiles", { count: 3, messageCount: "2 条消息" })).toBe("3 个源文件 · 智能体就绪 · 2 条消息");
    expect(translate("zh-CN", "relation.depends_onDescription")).toContain("依赖目标模块");
    expect(translate("zh-CN", "sequence.generated", { counts: "2 条架构消息" })).toBe(
      "序列图生成完成：2 条架构消息。"
    );
    expect(translate("zh-CN", "desktopOnly.title")).toBe("请从桌面端打开 FlowWeave");
    expect(translate("zh-CN", "agent.bridgeWarning")).not.toContain("浏览器预览");
    expect(translate("zh-CN", "agent.codexDescription")).toContain("本地 Codex CLI");
    expect(translate("zh-CN", "agent.claudeDesktopDescription")).toContain("agent-bridge");
    expect(translate("zh-CN", "agent.codexDesktopDescription")).toContain("response.json");
    expect(translate("zh-CN", "agent.geminiDescription")).toContain("Gemini CLI");
    expect(translate("zh-CN", "agent.healthCheck")).toBe("健康检查");
    expect(translate("zh-CN", "agent.connectorPrompt")).toBe("连接提示");
    expect(translate("zh-CN", "agent.copyConnector")).toBe("复制连接");
    expect(translate("zh-CN", "agent.protocolCli")).toBe("CLI stdin");
    expect(translate("zh-CN", "agent.protocolDesktop")).toBe("Desktop bridge");
    expect(translate("zh-CN", "agent.capabilityArtifactAnalysis")).toBe("产物分析");
    expect(translate("zh-CN", "module.manualSubtitle")).toBe("手动补充模块");
    expect(translate("zh-CN", "assessment.high")).toBe("高");
    expect(translate("zh-CN", "settings.planTimeout")).toContain("计划超时");
    expect(translate("zh-CN", "module.riskOverridePrompt")).toContain("覆写");
    expect(translate("zh-CN", "artifact.state.stale")).toBe("已过期");
    expect(translate("zh-CN", "artifact.sequences")).toBe("架构时序图");
    expect(translate("zh-CN", "onboarding.title")).toContain("先理解项目");
    expect(translate("zh-CN", "settings.executeTimeout")).toContain("分钟");
    expect(translate("zh-CN", "settings.scanBudget")).toBe("扫描条目预算");
  });

  it("keeps both locale dictionaries aligned", () => {
    expect(Object.keys(translationMessages.en).sort()).toEqual(Object.keys(translationMessages["zh-CN"]).sort());
  });

  it("does not ship Chinese copy in the English dictionary", () => {
    const contaminatedEntries = Object.entries(translationMessages.en).filter(([, value]) => /[\u3400-\u9fff]/u.test(value));
    expect(contaminatedEntries).toEqual([]);
  });

  it("uses English as the default locale for new installations", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("localizes generated Canvas text from current and legacy artifacts", () => {
    const node: GraphNode = {
      id: "services",
      title: "Services",
      subtitle: "后端业务模块",
      kind: "module",
      nodeType: "module",
      risk: "normal",
      description: "Services 模块由项目扫描生成，包含 2 个关键文件，连接关系将作为 Agent 生成计划的范围依据。",
      files: ["src/a.ts", "src/b.ts"],
      guidanceDraft: "请围绕 Services 检查这些文件的职责边界，并只在连接关系要求时扩展修改范围。",
      status: "mapped",
      x: 0,
      y: 0
    };

    expect(localizedModuleDescription(node, (key, params) => translate("en", key, params))).toContain(
      "was generated from the project scan"
    );
    expect(localizedModuleGuidance(node, (key, params) => translate("zh-CN", key, params))).toContain(
      "职责边界"
    );
  });

  it("localizes generated Sequence Diagram boilerplate", () => {
    const diagram: SequenceDiagram = {
      id: "architectural-sequence",
      title: "Architectural Sequence Diagram",
      kind: "architectural",
      summary: "Macro collaboration inferred from architecture modules and relationships.",
      participants: [
        { id: "a", title: "A", kind: "service", description: "Source file src/a.ts.", filePath: "src/a.ts" },
        { id: "b", title: "B", kind: "service", description: "Source file src/b.ts.", filePath: "src/b.ts" }
      ],
      messages: [{
        id: "a-b",
        sequence: 1,
        from: "a",
        to: "b",
        kind: "sync",
        label: "A collaborates with B",
        description: "Inferred sequence relation from available project structure.",
        input: "project context",
        output: "next step result",
        evidence: [{ filePath: "src/a.ts", detail: "Inferred sequence participant." }]
      }],
      evidence: []
    };
    const localized = localizedSequenceDiagram(diagram, (key, params) => translate("zh-CN", key, params));

    expect(localized.title).toBe("架构时序图");
    expect(localized.messages[0].label).toBe("A 与 B 协作");
    expect(localized.messages[0].description).toBe("根据现有项目结构推断的时序关系。");
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

  it("starts the split Agent and Canvas stores without a demo graph", () => {
    expect(useAgentStore.getState().selectedAgentId).toBe("claude-code");
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useCanvasStore.getState().modules).toEqual([]);
  });
});

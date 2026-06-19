# FlowWeave Agent 一键生成功能实现指南

> 策略：**只增文件不改架构**。全部复用现有的 `runToolPlan` IPC 通道和 `startToolPlan` 服务体系，不新建 IPC、不新建 Service、不改 preload。

## 一、改动范围一览

| 动作 | 文件 | 原因 |
|------|------|------|
| **新建** | `src/utils/agent-query-prompts.ts` | prompt 模板集中管理 |
| **修改** | `src/hooks/useModuleActions.ts` | 新增 Agent 分析 action，调用现有 `window.flowweave.runToolPlan` |
| **修改** | `src/hooks/useSequenceDiagramState.ts` | 新增参与者分析/消息验证 action |
| **修改** | `src/components/ModulePanel.tsx` | hero-card 区域加 "Agent 分析" 按钮 |
| **修改** | `src/components/StructureWorkspace.tsx` | 参与者/消息详情面板加分析按钮 |
| **可能修改** | `src/styles.css` | 少量新样式 |

**不动的层：**
- `src/common/ipc-channels.ts` — 不新增通道，复用 `tool:run-plan`
- `src/main/ipc/agent.ipc.ts` — 不新增 handler
- `src/main/services/agent-run.service.ts` — 直接用 `startToolPlan`
- `src/preload/index.ts` — 不新增 API，直接用 `runToolPlan`
- `src/types.ts` — 不新增类型（结果合并到已有 `GraphNode` / `SequenceDiagram` 字段）

## 二、核心思路：桥接现有 `runToolPlan`

当前 `StartToolPlanOptions` 已有 `purpose: "artifact-analysis"` 模式。我们利用它：

```typescript
// 现有 API，直接复用
window.flowweave.runToolPlan({
  projectId,
  toolId: agentId,
  prompt: buildModuleAnalysisPrompt(module, edges),  // 新 prompt 模板
  executionMode: "plan",
  purpose: "artifact-analysis",
  planTimeoutMs: 120_000  // 单模块分析 2 分钟够了
})
// → 返回 StartToolPlanResult，其中 outputText 包含 Agent JSON 响应
```

Agent 返回的 JSON 通过 `result.outputText` 获取，本地解析后合并到现有数据结构。

## 三、具体实现

### Step 1: 新建 `src/utils/agent-query-prompts.ts`

这是唯一的新文件，参考现有 [src/utils/agent-connector-prompts.ts](src/utils/agent-connector-prompts.ts) 的组织方式。

```typescript
import type {
  ArchitectureEvidence,
  GraphEdge,
  GraphNode,
  SequenceMessage,
  SequenceParticipant,
  StructureSymbol
} from "../types";

// ============================================================
// 1. 模块分析 prompt
// ============================================================

export function buildModuleAnalysisPrompt(
  module: Pick<GraphNode, "id" | "title" | "description" | "files" | "fileRoles" | "symbols" | "evidence" | "category" | "role">,
  relatedEdges: Array<{ source: string; target: string; relation: string; description?: string; evidence?: ArchitectureEvidence[] }>,
): string {
  const moduleInfo = {
    id: module.id,
    title: module.title,
    currentDescription: module.description,
    category: module.category,
    role: module.role,
    files: module.files,
    fileRoles: module.fileRoles,
    symbols: module.symbols?.slice(0, 50),
    evidence: module.evidence?.slice(0, 30),
  };

  const relations = relatedEdges.slice(0, 30).map((edge) => ({
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    description: edge.description,
    evidence: edge.evidence?.slice(0, 5),
  }));

  return `You are FlowWeave's module analyst. Return only JSON.

Goal:
Analyze one architecture module deeply. Provide: enhanced description, per-file role descriptions, risk assessment, and confidence assessment.

Module:
${JSON.stringify(moduleInfo, null, 2)}

Relationships:
${JSON.stringify(relations, null, 2)}

Analysis priorities:
- Use only the supplied module info and relationship data. Do not invent files, symbols, or calls.
- Describe what this module does from a functional/architectural perspective.
- For each file, explain its specific role within the module.
- Assess risk: consider sensitive operations (auth, payment, data), dependency centrality, side effects, change impact, and test coverage gaps.
- Assess confidence: consider how well the supplied evidence supports the analysis.

Return this exact JSON shape:
{
  "enhancedDescription": "one paragraph describing the module's functional role",
  "fileRoles": [{ "path": "string", "role": "what this file does in the module" }],
  "riskAssessment": {
    "level": "low|medium|high",
    "reason": "summary of why this risk level",
    "factors": [{ "label": "factor name", "score": 0-100, "maxScore": 100, "reason": "why this score" }]
  },
  "confidenceAssessment": {
    "level": "low|medium|high",
    "score": 0-100,
    "reason": "why this confidence level"
  }
}

Rules:
- enhancedDescription must be 1-3 sentences, functional not technical.
- fileRoles must include every file from the module.files list.
- riskAssessment.level: high = sensitive + central + many side effects; low = utility with tests.
- confidenceAssessment.score: 80+ = strong evidence; 50-79 = moderate; <50 = sparse evidence.
- Return valid JSON only. No markdown fences.`;
}

// ============================================================
// 2. 时序图参与者分析 prompt
// ============================================================

export function buildParticipantAnalysisPrompt(
  participant: Pick<SequenceParticipant, "id" | "title" | "kind" | "description" | "filePath" | "symbol">,
  relatedMessages: Array<Pick<SequenceMessage, "from" | "to" | "label" | "methodName" | "kind">>,
  fileContent?: string
): string {
  const participantInfo = {
    id: participant.id,
    title: participant.title,
    kind: participant.kind,
    description: participant.description,
    filePath: participant.filePath,
    symbol: participant.symbol,
  };

  const messages = relatedMessages.slice(0, 20).map((message) => ({
    from: message.from,
    to: message.to,
    label: message.label,
    methodName: message.methodName,
    kind: message.kind,
  }));

  const codeHint = fileContent
    ? `\nSource file snippet (first 500 lines):\n\`\`\`\n${fileContent.slice(0, 8000)}\n\`\`\``
    : "";

  return `You are FlowWeave's sequence diagram analyst. Return only JSON.

Goal:
Analyze one sequence diagram participant and provide enhanced description, architecture role, and key symbols.

Participant:
${JSON.stringify(participantInfo, null, 2)}

Related Messages:
${JSON.stringify(messages, null, 2)}
${codeHint}

Analysis priorities:
- Describe what this participant does in the sequence workflow.
- Identify its architectural role (entry point, orchestrator, data handler, external gateway, worker, etc.).
- If fileContent is provided, extract key symbols (functions, classes, methods) that matter.

Return this exact JSON shape:
{
  "enhancedDescription": "what this participant does in the workflow",
  "role": "architectural role label",
  "keySymbols": [{ "name": "symbol name", "kind": "function|class|method|export", "role": "why it matters" }]
}

Rules:
- enhancedDescription must be 1-2 sentences.
- keySymbols may be empty if no file content was supplied.
- Return valid JSON only. No markdown fences.`;
}

// ============================================================
// 3. 时序图消息验证 prompt
// ============================================================

export function buildMessageVerificationPrompt(
  message: Pick<SequenceMessage, "from" | "to" | "label" | "methodName" | "input" | "output" | "kind" | "evidence">,
  sourceFileContent?: string,
  targetFileContent?: string
): string {
  const messageInfo = {
    from: message.from,
    to: message.to,
    label: message.label,
    methodName: message.methodName,
    input: message.input,
    output: message.output,
    kind: message.kind,
    existingEvidence: message.evidence?.slice(0, 10),
  };

  const sourceCode = sourceFileContent
    ? `\nSource participant file (first 500 lines):\n\`\`\`\n${sourceFileContent.slice(0, 6000)}\n\`\`\``
    : "";
  const targetCode = targetFileContent
    ? `\nTarget participant file (first 500 lines):\n\`\`\`\n${targetFileContent.slice(0, 6000)}\n\`\`\``
    : "";

  return `You are FlowWeave's code evidence verifier. Return only JSON.

Goal:
Verify whether a sequence diagram message (call/event/return) has supporting evidence in the source code.

Message:
${JSON.stringify(messageInfo, null, 2)}
${sourceCode}
${targetCode}

Verification priorities:
- Check if methodName appears as a function/method call or definition in the provided source files.
- If verified, provide the actual method signature and the evidence (file path, line, detail).
- If not verified, explain why and suggest what to look for.

Return this exact JSON shape:
{
  "verified": true|false,
  "confidence": 0-100,
  "actualMethod": "verified method name or empty string",
  "actualInput": "verified input params or empty string",
  "actualOutput": "verified return value or empty string",
  "evidence": [{ "filePath": "path", "line": number, "detail": "code evidence" }],
  "note": "explanation if not verified"
}

Rules:
- verified must be false when no code evidence supports the message.
- evidence array may be empty if not verified.
- Return valid JSON only. No markdown fences.`;
}

// ============================================================
// 4. 结果解析工具
// ============================================================

export type ModuleAnalysisOutput = {
  enhancedDescription: string;
  fileRoles: Array<{ path: string; role: string }>;
  riskAssessment: {
    level: "low" | "medium" | "high" | "unknown";
    reason: string;
    factors: Array<{ label: string; score: number; maxScore: number; reason: string }>;
  };
  confidenceAssessment: {
    level: "low" | "medium" | "high" | "unknown";
    score: number;
    reason: string;
  };
};

export type ParticipantAnalysisOutput = {
  enhancedDescription: string;
  role: string;
  keySymbols: Array<{ name: string; kind: string; role: string }>;
};

export type MessageVerificationOutput = {
  verified: boolean;
  confidence: number;
  actualMethod: string;
  actualInput: string;
  actualOutput: string;
  evidence: ArchitectureEvidence[];
  note: string;
};

/**
 * 从 Agent 输出文本中提取首个 JSON 对象。
 * 兼容带 markdown fence 的输出。
 */
export function parseAgentJsonOutput<T>(outputText: string): T | undefined {
  // 去除可能的 markdown fence
  let json = outputText.trim();
  const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    json = fenceMatch[1].trim();
  }
  // 找到第一个 { 和最后一个 }
  const start = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (start === -1 || end === -1) return undefined;
  try {
    return JSON.parse(json.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
```

### Step 2: 扩展 `src/hooks/useModuleActions.ts`

在现有 hook 返回值中新增 **3 个字段**，完全沿用现有模式：

```typescript
// 新增 import
import type { RuntimeAgentId } from "../types";
import {
  buildModuleAnalysisPrompt,
  parseAgentJsonOutput,
  type ModuleAnalysisOutput,
} from "../utils/agent-query-prompts";

// useModuleActions 参数新增：
export function useModuleActions({
  addModuleNode,
  dialogText,
  selectedNode,
  setDialogText,
  setSelectedNodeId,
  togglePath,
  updateModule,
  // === 新增参数 ===
  projectId,          // string — 用于 window.flowweave.runToolPlan
  projectPath,        // string — 用于构建 prompt
  edges,              // GraphEdge[] — 用于构建模块关系的 prompt
  setLastRunStatus,   // (status: string) => void — 操作状态反馈
}: {
  // ... 现有参数 ...
  // === 新增参数 ===
  projectId: string;
  projectPath: string;
  edges: import("../types").GraphEdge[];
  setLastRunStatus: (status: string) => void;
}) {
  const { t } = useI18n();

  // === 新增状态 ===
  const [isAgentAnalyzing, setIsAgentAnalyzing] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");

  // ... 现有 selectNode, addNode, updateGuidance, applyDialog, writeDraft ...

  // === 新增：Agent 分析当前模块 ===
  async function analyzeModuleWithAgent(agentId: RuntimeAgentId) {
    if (!window.flowweave || !selectedNode || !projectId) {
      setAgentStatus(t("module.agentUnavailable"));
      return;
    }
    setIsAgentAnalyzing(true);
    setAgentStatus(t("module.agentAnalyzing"));
    try {
      const prompt = buildModuleAnalysisPrompt(
        selectedNode,
        edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id),
      );

      const result = await window.flowweave.runToolPlan({
        projectId,
        toolId: agentId,
        prompt,
        executionMode: "plan",
        purpose: "artifact-analysis",
        planTimeoutMs: 120_000,
      });

      if (result.status !== "completed" || !result.outputText) {
        throw new Error(result.summary ?? result.stderr ?? "Agent 未返回有效结果");
      }

      const analysis = parseAgentJsonOutput<ModuleAnalysisOutput>(result.outputText);
      if (!analysis) {
        throw new Error("Agent 返回的 JSON 无法解析");
      }

      // 合并结果到模块
      updateModule(selectedNode.id, (node) => ({
        ...node,
        description: analysis.enhancedDescription || node.description,
        fileRoles: analysis.fileRoles?.length
          ? analysis.fileRoles
          : node.fileRoles,
        assessment: {
          version: 1,
          generatorVersion: "agent-query-v1",
          confidence: {
            score: analysis.confidenceAssessment?.score ?? 50,
            level: analysis.confidenceAssessment?.level ?? "medium",
            factors: [
              {
                id: "agent-semantic-analysis",
                label: "Agent 语义分析",
                score: analysis.confidenceAssessment?.score ?? 50,
                maxScore: 100,
                reason: analysis.confidenceAssessment?.reason ?? "Agent 基于模块代码语义分析",
                evidence: [{ detail: "Agent 基于模块结构和关系证据生成" }],
              },
            ],
          },
          risk: {
            systemLevel: analysis.riskAssessment?.level ?? "medium",
            effectiveLevel: analysis.riskAssessment?.level ?? "medium",
            systemScore: analysis.riskAssessment?.factors?.reduce((sum, f) => sum + f.score, 0),
            factors: analysis.riskAssessment?.factors?.map((f, i) => ({
              id: `agent-risk-${i}`,
              label: f.label,
              score: f.score,
              maxScore: f.maxScore,
              reason: f.reason,
              evidence: [{ detail: "Agent 风险评估" }],
            })) ?? [],
          },
          fingerprint: "",
          assessedAt: new Date().toISOString(),
        },
        status: "mapped" as const,
      }));

      setAgentStatus(t("module.agentAnalysisDone"));
      setLastRunStatus(t("module.agentAnalysisDoneShort", { title: selectedNode.title }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAgentStatus(t("module.agentAnalysisFailed", { error: message }));
      setLastRunStatus(message);
    } finally {
      setIsAgentAnalyzing(false);
    }
  }

  return {
    addNode,
    applyDialog,
    selectNode,
    toggleProjectPath: togglePath,
    updateGuidance,
    writeDraft,
    // === 新增返回值 ===
    agentStatus,
    isAgentAnalyzing,
    analyzeModuleWithAgent,
  };
}
```

### Step 3: 扩展 `src/hooks/useSequenceDiagramState.ts`

同理，在现有 hook 返回值中新增参与者分析和消息验证：

```typescript
// 新增 import
import {
  buildParticipantAnalysisPrompt,
  buildMessageVerificationPrompt,
  parseAgentJsonOutput,
  type ParticipantAnalysisOutput,
  type MessageVerificationOutput,
} from "../utils/agent-query-prompts";

// 在 useSequenceDiagramState 参数中新增 projectId
// 在返回值中新增：

export type SequenceDiagramState = {
  // ... 现有字段 ...
  
  // === 新增 ===
  isAnalyzing: boolean;
  analysisStatus: string;
  analyzeParticipant: (participant: SequenceParticipant) => Promise<void>;
  verifyMessage: (message: SequenceMessage) => Promise<void>;
};

// 实现：

const [isAnalyzing, setIsAnalyzing] = useState(false);
const [analysisStatus, setAnalysisStatus] = useState("");

async function analyzeParticipant(participant: SequenceParticipant) {
  if (!window.flowweave || !projectId || isAnalyzing) return;
  setIsAnalyzing(true);
  setAnalysisStatus(t("structure.analyzingParticipant", { title: participant.title }));
  try {
    const relatedMessages = diagram?.messages.filter(
      (m) => m.from === participant.id || m.to === participant.id
    ) ?? [];

    let fileContent: string | undefined;
    if (participant.filePath) {
      try {
        fileContent = await window.flowweave.readProjectFile(projectId, participant.filePath);
      } catch { /* file may not exist */ }
    }

    const prompt = buildParticipantAnalysisPrompt(participant, relatedMessages, fileContent);

    const result = await window.flowweave.runToolPlan({
      projectId,
      toolId: selectedAgentId,
      prompt,
      executionMode: "plan",
      purpose: "artifact-analysis",
      planTimeoutMs: 60_000,
    });

    if (result.status !== "completed" || !result.outputText) {
      throw new Error(result.summary ?? "Agent 未返回有效结果");
    }

    const analysis = parseAgentJsonOutput<ParticipantAnalysisOutput>(result.outputText);
    if (!analysis) throw new Error("Agent 返回的 JSON 无法解析");

    setAnalysisStatus(t("structure.participantAnalysisDone", { title: participant.title }));
    // 结果通过 selectedParticipant 的详情面板展示
    setParticipantAnalysis(analysis);
  } catch (error) {
    setAnalysisStatus(t("structure.analysisFailed", { error: formatErrorMessage(error) }));
  } finally {
    setIsAnalyzing(false);
  }
}

async function verifyMessage(message: SequenceMessage) {
  // 类似 analyzeParticipant，但用 buildMessageVerificationPrompt
  // 读取 source/target 文件内容
  // 结果展示在消息详情面板
}
```

### Step 4: 更新 `src/components/ModulePanel.tsx`

在 `hero-card` 中已有 confidence/risk 展示，**紧接其下**添加一个 Agent 操作行：

```tsx
// 新增 props
type ModulePanelProps = {
  // ... 现有 props ...
  agentId?: RuntimeAgentId;
  agentStatus?: string;
  isAgentAnalyzing?: boolean;
  onAnalyzeModule?: (agentId: RuntimeAgentId) => void;
};

// 在 ModulePanel 函数体中，hero-card 的 {node.assessment ? ... : ...} 之后添加：

{onAnalyzeModule && agentId ? (
  <div className="module-agent-row">
    <button
      className="ghost-button"
      disabled={isAgentAnalyzing}
      type="button"
      onClick={() => onAnalyzeModule(agentId)}
    >
      <BrainCircuit size={14} />
      {isAgentAnalyzing ? "Agent 分析中…" : "Agent 分析此模块"}
    </button>
    {agentStatus ? <span className="module-agent-status">{agentStatus}</span> : null}
  </div>
) : null}
```

### Step 5: 更新 `src/components/StructureWorkspace.tsx`

在 `SequenceDetails` 函数中，参与者详情和消息详情的 card 内添加分析按钮：

```tsx
// 参与者详情（在 <EvidenceList> 之前或之后）
{participant && onAnalyzeParticipant ? (
  <section className="module-card">
    <button
      className="ghost-button sequence-wide-button"
      disabled={isAnalyzing}
      type="button"
      onClick={() => onAnalyzeParticipant(participant)}
    >
      <Search size={14} />
      {isAnalyzing ? "分析中…" : "Agent 分析此参与者"}
    </button>
    {analysisStatus ? <p className="sequence-status">{analysisStatus}</p> : null}
  </section>
) : null}

// 消息详情（同理）
{message && onVerifyMessage ? (
  <section className="module-card">
    <button
      className="ghost-button sequence-wide-button"
      disabled={isAnalyzing}
      type="button"
      onClick={() => onVerifyMessage(message)}
    >
      <CheckCircle size={14} />
      {isAnalyzing ? "验证中…" : "Agent 验证消息关系"}
    </button>
  </section>
) : null}
```

### Step 6: 连线（`src/hooks/useAppController.ts`）

在 `useAppController` 中把新增的 params 传给 `useModuleActions` 和 `useSequenceDiagramState`：

```typescript
// 传给 useModuleActions 的新参数
const moduleActions = useModuleActions({
  addModuleNode: flow.addModuleNode,
  dialogText,
  selectedNode: flow.selectedNode,
  setDialogText,
  setSelectedNodeId: flow.setSelectedNodeId,
  togglePath: flow.togglePath,
  updateModule: flow.updateModule,
  // === 新增 ===
  projectId,
  projectPath,
  edges: flow.graphRelations,
  setLastRunStatus,
});

// canvas 返回值中新增传给 ModulePanel 的 props：
canvas: {
  // ... 现有字段 ...
  agentStatus: moduleActions.agentStatus,
  isAgentAnalyzing: moduleActions.isAgentAnalyzing,
  onAnalyzeModule: moduleActions.analyzeModuleWithAgent,
}
```

## 四、数据流图

```
ModulePanel                      StructureWorkspace
  │ [Agent 分析此模块]               │ [分析此参与者]
  ▼                                  ▼
useModuleActions                  useSequenceDiagramState
  │ buildModuleAnalysisPrompt()      │ buildParticipantAnalysisPrompt()
  ▼                                  ▼
window.flowweave.runToolPlan({    window.flowweave.runToolPlan({
  prompt,                           prompt,
  purpose: "artifact-analysis",      purpose: "artifact-analysis",
  executionMode: "plan"              executionMode: "plan"
})                                })
  │ IPC: tool:run-plan               │ IPC: tool:run-plan
  ▼                                  ▼
agent.ipc.ts                      agent.ipc.ts
  │                                  │
  ▼                                  ▼
startToolPlan()                   startToolPlan()
  │                                  │
  ▼                                  ▼
Agent CLI (Claude/Codex/Gemini)   Agent CLI
  │ 返回 JSON                        │ 返回 JSON
  ▼                                  ▼
parseAgentJsonOutput()            parseAgentJsonOutput()
  │                                  │
  ▼                                  ▼
updateModule(selectedNode.id,     setParticipantAnalysis()
  { description, fileRoles,         → 展示在详情面板
    assessment })
  → Canvas 自动持久化
```

## 五、不改动的部分（确认清单）

| 组件 | 状态 | 说明 |
|------|------|------|
| `src/common/ipc-channels.ts` | ❌ 不动 | 复用 `tool:run-plan` |
| `src/main/ipc/agent.ipc.ts` | ❌ 不动 | 复用 `runPlan` handler |
| `src/main/services/agent-run.service.ts` | ❌ 不动 | 复用 `startToolPlan` |
| `src/main/services/architecture-analysis.service.ts` | ❌ 不动 | 不相关 |
| `src/main/services/sequence-diagram.service.ts` | ❌ 不动 | 不相关 |
| `src/main/services/project-agent-connection.service.ts` | ❌ 不动 | 不相关 |
| `src/preload/index.ts` | ❌ 不动 | 复用 `runToolPlan` |
| `src/types.ts` | ❌ 不动 | 结果合并到已有字段 |
| `src/stores/*` | ❌ 不动 | Canvas 持久化已有 |
| `src/common/ipc-channels.ts` | ❌ 不动 | 复用现有通道 |

## 六、实现顺序

```
1. 新建 src/utils/agent-query-prompts.ts      ← 纯函数，无依赖
2. 修改 src/hooks/useModuleActions.ts         ← 依赖 step 1
3. 修改 src/hooks/useSequenceDiagramState.ts   ← 依赖 step 1
4. 修改 src/hooks/useAppController.ts          ← 连线 step 2,3
5. 修改 src/components/ModulePanel.tsx         ← 加按钮
6. 修改 src/components/StructureWorkspace.tsx   ← 加按钮
7. 修改 src/styles.css                         ← 少量样式（可选）
```

## 七、验证清单

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 启动应用 → 打开项目 → 点击模块节点 → 确认 ModulePanel 出现 "Agent 分析此模块" 按钮
- [ ] 选择 Agent → 点击按钮 → Agent 被调用 → 模块描述/风险评估/文件角色更新
- [ ] 切换到 Structure 页面 → 点击参与者 → 出现 "Agent 分析此参与者" 按钮
- [ ] 点击按钮 → Agent 返回分析结果 → 详情面板更新
- [ ] 点击消息 → 出现 "Agent 验证消息关系" 按钮
- [ ] Agent 不可用时按钮 disabled
- [ ] Agent 分析过程中按钮显示 loading 状态
- [ ] 分析结果自动持久化（Canvas 已有 auto-save）

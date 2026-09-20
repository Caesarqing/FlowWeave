# 模块图更新性能整改实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 让“更新模块图”先快速、确定性地产出本地模块图，再在后台完成唯一有效的 Agent 语义增强，消除重复上下文、重复审核和旧审核覆盖新结果的问题。

**Architecture:** 静态分析是模块拓扑、文件归属和连接证据的唯一事实来源；Agent 只增强模块名称、职责说明、风险提示和缺失诊断，不再重建拓扑。模块图更新拆成“本地生成”和“Agent 增强”两个独立状态，并使用 `projectId + artifactTarget + inputFingerprint + reviewId` 保证只有最新审核可以落盘；`inputFingerprint` 同时覆盖源代码扫描和分析器配置版本。

**Tech Stack:** Electron、TypeScript、React、Zustand、Vitest、ELK、FlowWeave Agent Inbox v2。

---

## 1. 范围和优先级

本计划覆盖以下已确认整改项：

- **P0**：阻止同一模块图出现多个有效审核，禁止旧审核覆盖新审核。
- **P0**：本地模块图完成后立即解除“生成中”，Agent 审核不得阻塞本地结果。
- **P1**：取消“Agent 重建完整模块图、最终又丢弃其拓扑”的重复计算。
- **P1**：把动态架构审核 prompt 控制在不超过 32,000 字符；字符数与 token 数不做固定换算，adapter 能提供 tokenizer 时同时记录实际/估算 token。
- **P1**：将 UI 明确拆分为“本地分析结果”和“Agent 增强状态”。
- **P2**：恢复并强化性能基准，防止扫描、语义索引、提示词和布局性能回退。

不在本计划内：模块分组算法和运行流程布局的重构，见 `2026-09-20-module-connection-remediation.md`；插件安装和项目连接迁移，见 `2026-09-20-plugin-connection-remediation.md`。

### 1.1 方案复核结论

本方案方向合理，但实施时必须补充以下约束，否则会出现“性能改善了、结果一致性仍不可靠”的情况：

1. **先保证唯一写入，再压缩提示词。** 并发写入问题是数据正确性问题，不能与提示词优化一起作为普通性能改造处理。
2. **相同审核键只能复用，不能产生两个有效审核。** 竞争测试模拟的是历史遗留 run、进程恢复或不同扫描指纹，不是允许 UI 重复创建同键 run。
3. **自动完成和手工导入必须经过同一采纳闸门。** `artifact-run-adoption.service.ts` 不能绕过最新 `reviewId` 校验。
4. **本地基线和活动结果必须分开。** `architecture-local.json` 是不可被 Agent 改写的对照基线，`architecture-map.json` 是 UI 当前活动结果。
5. **P2 删除只能在 P0/P1 通过迁移与回归门槛后进行。** 不允许一边切协议、一边删除唯一可回滚的数据。

### 1.2 与另外两份整改的执行依赖

推荐顺序：

1. 先完成插件连接方案的 P0 协议统一和当前根路径修复，确保 Agent Inbox v2 请求/响应路径可信。
2. 完成本方案 P0：审核唯一性、本地结果立即可见、所有采纳入口统一校验。
3. 完成本方案 P1：新增强契约、提示词预算和状态拆分。
4. 再执行模块连接方案 P0/P1；新聚类算法版本会形成新的 `inputFingerprint`，即使源文件未变化，旧审核也必须被判定为 stale。
5. 最后执行三份方案的 P2 删除与全量验证。

## 2. 当前问题与证据

### 2.1 Agent 输入与实际采纳逻辑不一致（P1）

当前 `buildArchitecturePrompt` 要求 Agent 返回完整 `modules` 和 `relationships`，但：

- `parseArchitectureJson` 不使用 Agent 返回的 `relationships`，而是重新调用本地 `inferFallbackRelationships`。
- `enhanceLocalArchitecture` 固定保留本地模块和本地关系。
- 只有 Agent 模块的文件集合与本地模块完全相同时，Agent 文案才会被采用。

因此，Agent 付出了完整架构重建成本，但最终只可能贡献少量文案。

涉及文件：

- `src/main/services/architecture-analysis.service.ts:159-212`
- `src/main/services/architecture-analysis.service.ts:215-240`
- `src/main/services/architecture-analysis.service.ts:792-815`
- `tests/main/architecture-analysis.test.ts:24-45`

### 2.2 提示词过大（P1）

2026-09-20 本地诊断基线：

| 指标 | 当前结果 |
|---|---:|
| 项目文件数 | 250 |
| 源代码文件数 | 208 |
| 语义关系数 | 2,494 |
| 本地扫描 | 约 25 ms |
| 首次语义索引 | 约 1,435 ms |
| 缓存命中语义索引 | 约 19 ms |
| 架构提示词 | 146,859 字符 |
| 粗略 token 数 | 约 36,715 |

40 个代表文件本身约 57,022 字符，120 条关系约 45,087 字符。主要延迟来自 Agent 输入、响应和可能的修复重试，不来自缓存命中的本地扫描。

### 2.3 后台审核存在覆盖竞争（P0）

- `startArchitectureReview` 后台启动 `completeArchitectureReview`。
- `analyzeArchitecture` 在审核刚开始后就返回，本地 `architectureFlights` 随即清理。
- Canvas 主按钮只受 `isProjectLoading` 控制；本地阶段结束后，即使 `architectureReview.state === "reviewing"`，仍可再次点击。
- 两个审核会写同一个 `architecture-review.json` 和 `architecture-map.json`。
- 审核结果写入前只检查扫描指纹，没有确认 `reviewId` 是否仍是最新值。

涉及文件：

- `src/main/services/architecture-analysis.service.ts:41-66`
- `src/main/services/architecture-review.service.ts:42-56`
- `src/main/services/architecture-review.service.ts:143-178`
- `src/hooks/useProjectActions.ts:258-301`
- `src/App.tsx:174-187`

### 2.4 本地基线没有稳定持久化（P0/P1）

`writeLocalArchitectureArtifacts` 在已有 Agent 结果时跳过本地写入。这会造成：

- UI 显示新的本地结果，磁盘仍保留上一次 Agent 结果。
- Agent connection 刷新可能读取旧架构摘要。
- 应用重启时无法可靠恢复本次本地基线。
- 本地/Agent diff 的比较基线不稳定。

涉及文件：`src/main/services/architecture-analysis.service.ts:257-261`。

### 2.5 性能基准已经失效（P2）

`scripts/run-performance-benchmarks.ts` 仍传入 `maxDepth` 和 `maxEntries`，但当前 `ScanProjectOptions` 已不包含这些字段。基准创建 10,000 个文件后，1000 文件场景实际仍扫描 10,000 个文件并直接失败。

涉及文件：

- `scripts/run-performance-benchmarks.ts:9-60`
- `src/main/services/project-scanner.service.ts:51-68`

## 3. 目标架构

### 3.1 产物模型

新增并明确以下职责：

| 产物 | 责任 | 写入者 |
|---|---|---|
| `.flowweave/architecture-local.json` | 当前扫描指纹的确定性静态基线 | 本地分析器 |
| `.flowweave/architecture-map.json` | 当前 UI 应展示的有效结果 | 本地分析器先写，最新 Agent 增强后覆盖 |
| `.flowweave/architecture-review.json` | 当前审核状态和唯一有效 `reviewId` | 审核协调器 |
| `.flowweave/runs/<run-id>/...` | 每次 Agent 请求、响应和采纳结果 | Agent run 服务 |

`architecture-map.json` 和 `architecture-local.json` 必须拥有相同 `inputFingerprint` 才允许比较或合并。这里不得继续把 `scanFingerprint` 与分析输入指纹混为一谈：

```text
inputFingerprint = hash(
  scanFingerprint
  + semanticIndexSchemaVersion
  + moduleClusteringConfigVersion
  + architectureGeneratorVersion
  + reviewContractVersion
)
```

`scanFingerprint` 只表示项目源输入；`inputFingerprint` 表示“能够产生同一确定性本地图”的完整输入。审核状态和 run metadata 同时保存二者。

### 3.2 更新状态机

```text
idle
  -> scanning
  -> indexing
  -> local-ready
  -> reviewing
  -> reviewed
       or review-failed
       or stale
```

状态规则：

1. `local-ready` 时 UI 必须立即显示本地结果并解除主操作加载态。
2. `reviewing` 是后台增强状态，不得使用全页阻塞加载态。
3. 相同 `inputFingerprint + agentId` 已在审核时，再次请求返回现有状态，不创建新 run。
4. 新扫描指纹或分析器配置版本产生新 `inputFingerprint` 时，旧审核立即标记为 `stale`；旧结果完成后只能写 run history，不得写活动架构图。
5. 只有状态文件中的最新 `reviewId` 可以持久化 reviewed 结果。

### 3.3 Agent 增强契约

Agent 不再返回完整图，只返回稳定 ID 对应的增强内容：

```ts
export type ArchitectureReviewResponse = {
  architectureStyle?: string;
  modules: Array<{
    moduleId: string;
    title?: string;
    role?: string;
    description?: string;
    assessmentNotes?: string;
  }>;
  findings: Array<{
    code: string;
    severity: "warning" | "error";
    moduleIds: string[];
    message: string;
    evidenceIds: string[];
  }>;
};
```

边、文件归属、模块 ID、风险评分和代码证据不得由 Agent 修改。

### 3.4 输入预算

建立显式 `ArchitecturePromptBudget`：

- 动态架构审核 prompt 最大字符数：32,000。
- 与插件方案配合后，run-specific prompt + `agent-context.md` 的 FlowWeave 可控文本目标不超过 40,000 字符；宿主系统指令和模型自身上下文单独计量，不伪装为 FlowWeave 可控预算。
- 每个模块最多 5 个文件、5 个符号、5 条证据。
- 每条边最多 2 条代表证据。
- 不发送完整 `ProjectStructureFacts`。
- 不发送已存在于 run request 中的重复项目上下文。
- 预算选择必须确定性执行：先保留模块身份和全部边摘要，再按 `severity -> confidence -> stable id` 选择代表证据，最后序列化并测量实际字符数。
- 任何模块至少保留 ID、标题、类别、文件数和一条入口/证据摘要；不能为了满足预算而删除整个模块。
- 超出预算时抛出 `ARCHITECTURE_PROMPT_BUDGET_EXCEEDED`，错误中包含模块数、边数、实际字符数、预算和最大贡献段；不得静默截断 JSON 或字符串中间部分。

### 3.5 审核身份、复用和替换规则

定义：

```ts
type ArchitectureReviewKey = {
  projectId: string;
  artifactTarget: "architecture-map";
  scanFingerprint: string;
  inputFingerprint: string;
  agentId: RuntimeAgentId;
};
```

- `reviewId` 是一次审核尝试的唯一 ID；`reviewKey` 决定请求是否可复用。
- 同一 `reviewKey` 处于 `reviewing` 时，重复点击返回现有状态，不启动新 run。
- 新 `inputFingerprint` 必须创建新 `reviewId`，并把旧审核标记为 stale；源代码未变但聚类/生成器版本改变也适用。
- 用户明确切换 Agent 时允许创建新 `reviewId`；旧 Agent 结果完成后只进入 run history。
- 应用恢复历史 reviewing run 时沿用原 `reviewId`，不得生成“恢复审核”的第二个身份。

### 3.6 持久化事务边界

所有活动架构写入必须经过一个主进程内、按 `projectPath + artifactTarget` 串行化的 coordinator：

1. 获取对应 artifact 的写锁。
2. 重新读取 `architecture-review.json`，不可使用启动审核时缓存的状态。
3. 同时比较 `reviewId`、`scanFingerprint`、`inputFingerprint`、`agentId` 和 `artifactTarget`。
4. 使用临时文件 + rename 原子写入 `architecture-map.json`。
5. 再写 reviewed 状态并发送 UI 事件。
6. 释放锁；不匹配的结果记录 `adoption: stale`，但不得改活动图和活动状态。

本地扫描写入也使用同一 coordinator：先写 `architecture-local.json`，再把同一内容提升为 local 活动图，最后登记 reviewing 状态。自动完成、应用恢复和手工 `adoptArtifactRun` 都必须调用同一个采纳函数。

### 3.7 可观测性字段

每次架构更新至少记录以下结构化字段，写入 run metadata 或 diagnostics，不写入普通插值日志：

- `projectId`、`scanFingerprint`、`inputFingerprint`、`reviewId`、`runId`、`agentId`。
- `scanMs`、`semanticIndexMs`、`localGraphMs`、`localReadyMs`、`reviewMs`。
- `promptChars`、`promptModuleCount`、`promptEdgeCount`、`promptEvidenceCount`。
- `promptTokenEstimate` 或 adapter 返回的 `promptTokens`；没有可靠 tokenizer 时字段缺省，不使用固定字符/token 比例伪造精度。
- `adoptionOutcome`：`applied | reused | stale | rejected | failed`。
- `rejectionCode` 和受影响 artifact 路径。

## 4. 行动边界

实施时必须遵守：

- 静态分析是拓扑唯一来源；本计划不得让 Agent 自动新增、删除、合并模块或连接。
- 不改变序列图审核流程，除非抽取可复用的“最新 review 写入保护”纯函数。
- 不删除用户手工创建的 Canvas 节点、连接、位置或指导语。
- 不自动执行 Agent 的代码修改能力；架构审核始终使用只读 `plan` 模式。
- 不把 Agent 失败降级为成功，不静默使用旧 Agent 结果。
- 不新增兜底解析器兼容旧响应；协议不匹配时明确失败并提示重新生成。
- 不让手工导入绕过审核状态、扫描指纹或最新 review 校验。
- 不在 renderer 内承担并发正确性；renderer 只负责防重复操作，主进程仍必须保证幂等与串行采纳。
- 不创建 Git commit；所有修改保持未提交，供用户审查。

## 5. 旧系统和旧代码删除清单

完成新路径并通过测试后，删除以下旧实现：

1. 删除 `architectureFlights` 的短生命周期去重逻辑，改由持久化 review coordinator 管理唯一活动审核。
2. 删除 `writeLocalArchitectureArtifacts` 中“已有 Agent 结果则跳过本地写入”的分支。
3. 删除要求 Agent 输出完整 `relationships` 的旧提示词字段。
4. 删除 `architecture-analysis.service.ts` 和 `artifact-run-adoption.service.ts` 中 `parseArchitectureJson` 对完整 Agent 架构图的旧解析路径，替换为统一的 `parseArchitectureReviewResponse`。
5. 删除按完整文件集合匹配的 `moduleFilesKey` 和旧 `enhanceLocalArchitecture`；新实现按稳定 `moduleId` 合并允许字段。
6. 删除 repair prompt 中最多复制 40,000 字符旧响应的逻辑，改为只传验证错误和受影响模块。
7. 删除旧 v1 `architecture-map.json` 的运行时兼容分支；重新扫描时直接生成当前版本。
8. 删除失效性能脚本中的 `maxDepth`、`maxEntries` 参数使用。

删除边界：只删除 FlowWeave 生成物和已由新实现替代的代码，不删除 `.flowweave/runs` 历史记录，不删除用户源代码或用户编辑的模块指导。

## 6. 实施任务

### Task 1：建立审核唯一性和最新写入保护（P0）

**Files:**

- Modify: `src/main/services/architecture-review.service.ts`
- Modify: `src/main/services/architecture-analysis.service.ts`
- Modify: `src/main/services/artifact-run-adoption.service.ts`
- Modify: `src/main/storage/artifact-store.ts`
- Modify: `src/types.ts`
- Test: `tests/main/architecture-review.test.ts`
- Test: `tests/main/architecture-analysis.test.ts`

**Steps:**

1. 写失败测试：相同 `reviewKey` 的第二次请求返回原 `reviewId/runId`，run 创建次数仍为 1。
2. 写失败测试：scan-1 的历史 run 在 scan-2 审核之后完成时，只能得到 stale adoption。
3. 写失败测试：源文件不变但 `moduleClusteringConfigVersion` 改变时，旧 run 因 `inputFingerprint` 不匹配而 stale。
4. 写失败测试：用户从 Agent A 切换到 Agent B 后，A 晚到的结果不能覆盖 B 的活动状态。
5. 写失败测试：手工导入旧 run 时与自动完成路径得到相同的 stale/rejected 结果。
6. 写失败测试：应用恢复 reviewing run 时沿用原 `reviewId`，不得创建第二个审核。
7. 新增完整 `inputFingerprint` 计算和按 artifact key 串行化的 review coordinator，并在锁内重新读取审核状态。
8. 将 `startArchitectureReview`、自动完成和 `adoptArtifactRun` 统一接入同一个 `adoptArchitectureReview` 纯校验 + 原子写入入口。
9. 删除短生命周期 `architectureFlights`；重复请求由 review key 和持久化状态处理。
10. 运行：

   ```bash
   npx vitest run tests/main/architecture-review.test.ts tests/main/architecture-analysis.test.ts
   ```

   Expected: 新增复用、跨指纹、切换 Agent、恢复和手工导入测试全部通过；同一 review key 不存在重复 run。

### Task 2：拆分本地结果和后台增强状态（P0/P1）

**Files:**

- Modify: `src/main/services/architecture-analysis.service.ts`
- Modify: `src/main/ipc/project.ipc.ts`
- Modify: `src/hooks/useProjectActions.ts`
- Modify: `src/components/ProjectStatusIndicator.tsx`
- Modify: `src/App.tsx`
- Test: `tests/renderer/architecture-review-events.test.ts`
- Test: `tests/renderer/project-status-indicator.test.ts`

**Steps:**

1. 写失败测试：IPC 返回本地图时，前端解除 `isProjectLoading`，审核状态仍可为 reviewing。
2. 写失败测试：reviewing 状态下主按钮不再创建重复审核；UI 提供明确的“Agent 增强中”状态。
3. 在主进程中先原子写入 `architecture-local.json` 和本地 `architecture-map.json`，再启动 Agent review。
4. 将 `analyzeProject` 的状态信息拆成 `localGenerationStatus` 和 `architectureReview`，不得复用一个文本状态表达两个阶段。
5. Canvas 保持可浏览、可缩放、可打开详情；仅禁用会重新启动同一审核的动作。
6. 运行对应 renderer 测试并执行 `npm run typecheck`。

### Task 3：收缩 Agent 合约和提示词（P1）

**Files:**

- Modify: `src/main/services/architecture-analysis.service.ts`
- Create: `src/main/services/architecture-review-prompt.service.ts`
- Modify: `src/main/services/structured-output.service.ts`
- Modify: `src/types.ts`
- Test: `tests/main/architecture-analysis.test.ts`
- Create: `tests/main/architecture-review-prompt.test.ts`

**Steps:**

1. 写失败测试：提示词不得包含完整 `ProjectStructureFacts`，且不要求 Agent 返回关系或文件归属。
2. 写失败测试：给定当前项目规模的 fixture，提示词长度不超过 32,000 字符。
3. 写失败测试：未知 `moduleId`、重复 `moduleId`、非法 finding evidence 均返回明确验证错误。
4. 实现 `buildArchitectureReviewPrompt`，输入为本地模块图和已经聚合的代表证据。
5. 实现确定性 evidence selector；同一输入无论运行多少次都产生相同 prompt 和字符数。
6. 实现严格的 `parseArchitectureReviewResponse`；只接受允许的增强字段，拒绝 Agent 返回的拓扑字段。
7. 实现按 `moduleId` 的纯函数合并，确保不修改输入对象和本地拓扑。
8. 保留一次外部 Agent 修复重试，但 repair prompt 只包含 schema、验证错误和对应模块摘要，且同样受 32,000 字符预算约束。
9. 运行新增测试和现有 architecture tests。

### Task 4：修复并扩展性能基准（P2）

**Files:**

- Modify: `scripts/run-performance-benchmarks.ts`
- Modify: `package.json`
- Test: `tests/main/project-scanner.test.ts`
- Test: `tests/main/semantic-index.service.test.ts`

**Steps:**

1. 将 1,000、5,000、10,000 文件场景改成独立临时目录，测试规模由 fixture 决定，不依赖已删除的扫描参数。
2. 每个 warm 场景至少运行 20 次并报告 p50/p95；cold 场景至少运行 5 个独立临时目录。
3. 添加 cold index、warm index、prompt build、100/500/1000 节点布局四类结果。
4. 添加机器无关的硬门槛：warm index 相对 cold index 至少改善 70%；prompt 必须满足字符预算；任何场景不得改变节点或边数量。
5. 将 250 文件参考项目的 `localReadyMs` 目标记录为 warm p95 <= 500 ms、cold p95 <= 3 s；CI 先作为报告项，连续三次稳定后再升级为硬门槛。
6. 基准失败时输出场景、规模、迭代数、p50/p95、实际值和阈值。
7. 运行：

   ```bash
   npm run benchmark
   ```

   Expected: 所有规模完成并输出表格，不再在 1,000 文件场景读取 10,000 文件。

### Task 5：删除旧实现并执行全量验证（P0/P1/P2）

**Files:**

- Modify: `src/main/services/architecture-analysis.service.ts`
- Modify: `tests/main/architecture-analysis.test.ts`
- Modify: `docs/architecture.md`

**Steps:**

1. 使用 `rg` 确认旧符号不再被引用：`architectureFlights`、`moduleFilesKey`、旧 `buildArchitectureRepairPrompt`、完整图 response parser。
2. 删除旧实现和只验证旧行为的测试。
3. 更新 `docs/architecture.md`，记录“静态拓扑 + Agent 语义增强”的职责边界。
4. 执行：

   ```bash
   npm run typecheck
   npm test
   npm run benchmark
   npm run build
   ```

5. 检查 `git diff --check` 和 `git status --short`；保持修改未提交。

## 7. 测试矩阵

| 类别 | 场景 | 预期 |
|---|---|---|
| 单审核 | 相同指纹重复点击 | 复用现有 review，不新建 run |
| 并发 | review A 后启动、后完成 | A 不得覆盖最新 review B |
| 指纹 | 代码变化后旧响应到达 | 标记 stale，只写历史 |
| 指纹 | 代码未变但分析器/聚类版本改变 | 生成新 inputFingerprint，旧响应 stale |
| 本地阶段 | Agent 不可用 | 本地图正常显示，审核明确失败 |
| Prompt | 大项目 | 不超过字符预算，JSON 完整有效 |
| 解析 | Agent 返回拓扑字段 | 明确拒绝，不静默忽略 |
| 合并 | Agent 返回未知模块 | 明确失败并包含 moduleId |
| UI | reviewing | Canvas 可用，状态明确，不能重复启动 |
| 性能 | warm cache | 本地结果 p95 小于 500 ms（250 文件基线） |
| 性能 | cold cache | 本地结果 p95 小于 3 s（250 文件基线） |

### 7.1 发布闸门

| 闸门 | 进入条件 | 退出条件 | 失败处理 |
|---|---|---|---|
| G0 基线 | 当前测试可运行 | 保存现有耗时、prompt 大小、run 数量 | 基线命令失败则先修基准，不改协议 |
| G1 一致性 | coordinator 与统一采纳入口完成 | 并发/恢复/手工导入测试全部通过 | 不进入 prompt 改造 |
| G2 合约 | review response schema 完成 | 拓扑字段被拒绝，32k 预算通过 | 保留新本地路径，审核显示失败 |
| G3 性能 | 新基准脚本完成 | warm/cold/prompt/layout 场景全部执行 | 不删除旧解析代码 |
| G4 清理 | 全量测试、构建通过 | 旧符号为零，旧产物有迁移记录 | 停止删除并保留旧文件 |

### 7.2 人工验收脚本

1. 使用当前 FlowWeave 项目预热一次索引，再点击“更新模块图”；记录本地图可交互时间和 Agent 完成时间，二者必须是两个状态。
2. 在 reviewing 阶段连续点击 5 次更新；run history 只能新增 1 个相同 review key 的 run。
3. 启动 Agent A 后修改一个源文件并重新扫描；让 A 的旧响应最后返回，活动图仍必须对应新 `inputFingerprint`。
4. 启动 Agent A 后明确切换 Agent B；A 晚到结果只进入历史，UI 状态保持 B。
5. reviewing 阶段关闭并重新打开应用；恢复后 `reviewId/runId` 不变，不产生第二个审核。
6. 断开 Agent 或让响应 schema 非法；本地图仍可浏览，状态显示明确失败和 run 路径。

## 8. 验收标准

- 本地模块图在 Agent 启动前可见，且不因 Agent 慢响应保持全局 loading。
- 任意时间每个完整 `reviewKey` 最多一个有效审核；同项目的新 `inputFingerprint` 或新 Agent 会明确替换旧活动审核。
- `scanFingerprint` 与 `inputFingerprint` 职责分离，生成器或聚类配置变化不会错误复用旧审核。
- 旧审核不能覆盖新审核。
- Agent 输入不再包含完整文件/关系事实，提示词满足 32,000 字符预算。
- Agent 只能修改允许的语义增强字段。
- `npm run benchmark` 可运行并覆盖 prompt 大小。
- 相关测试、全量测试、类型检查和构建全部通过。
- 删除清单完成，`rg` 不再发现旧核心符号。
- 自动完成、应用恢复、手工导入三条路径使用相同采纳入口和错误码。
- diagnostics 能区分本地耗时、Agent 耗时、复用、stale 和拒绝，不再把所有慢操作归为“更新中”。

## 9. 回滚与故障处理

- 新状态机上线前先保留 `.flowweave/runs`，以便调查响应时序；不得通过恢复旧写入竞争逻辑回滚。
- 如果 Agent 增强失败，活动 `architecture-map.json` 保持本地结果，状态明确为 `review-failed`。
- 如果本地分析失败，保留上一份有效活动图但标记 stale；不得伪装为本次成功结果。
- 如果发现 schema 不匹配，要求重新生成产物，不新增旧 schema fallback。
- 只有 G1-G3 均通过后才执行旧 parser 和旧 artifact 删除；回滚只能恢复前一版完整产物快照，不允许恢复两套并行写入逻辑。

## 10. 完成定义

本方案只有同时满足以下条件才算完成，而不是“代码已经合并”：

1. 用户点击更新后先看到新的本地图和明确的 Agent 后台状态。
2. 连续快速点击、切换 Agent、修改代码后旧响应返回、重启后恢复等场景均不能覆盖新结果。
3. 当前参考项目 prompt 从约 146,859 字符降到不超过 32,000 字符，且模块身份和全部边摘要仍完整。
4. 性能基准可重复运行，结果包含迭代数和 p50/p95。
5. 旧审核 parser、旧完整图 prompt 和旧短生命周期去重路径均已删除，且不存在新的兼容双轨。

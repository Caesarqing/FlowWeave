# 模块连接与运行流程展示整改实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 将模块图从“混合关系的代码依赖图”升级为默认可读的软件运行流程图，同时保留完整依赖分析能力，并让每个模块的职责、入口、上下游和证据清晰可见。

**Architecture:** 底层保存一份有证据的完整语义关系图，展示层按用途投影为“运行流程”“代码依赖”“架构分层”“技术栈”和“功能域”视图。静态分析负责模块划分和连接事实；AI 只增强说明，不允许改动拓扑；运行流程是基于静态调用、事件、数据和外部访问证据的推断视图，不伪装成动态 trace。

**Tech Stack:** TypeScript、React、Zustand、React Flow、ELK、FlowWeave semantic index、Vitest。

---

## 1. 范围和优先级

- **P0**：明确边的方向和语义，运行关系与导入依赖不得混为同一种流程。
- **P0**：新增默认“运行流程”视图，按入口到数据/外部系统排列。
- **P1**：改善模块划分，避免 `Shared Utilities`、`Main` 等超大且职责模糊的节点。
- **P1**：模块卡片和详情面板显示清晰职责、模块标题、主要入口及上下游，而不是裸 ID。
- **P1**：折叠分组时聚合组间边，不能因只保留代表节点而丢失连接。
- **P2**：移除旧布局别名、静态坐标和未使用节点组件，升级 Canvas schema。

### 1.1 方案复核结论

“一份事实图、多种投影视图”和“运行流程默认展示”的方向合理，但原方案仍有三处需要收紧：

1. `runtime` 目前表示技术栈布局，如果再加入 execution/runtime 流程会产生术语冲突；规范模式应使用完整语义名称。
2. `depends_on` 不能默认补进执行流程。import 只能证明静态依赖，不能证明真实调用，默认应隐藏，仅在用户主动开启“推断依赖覆盖层”时显示。
3. 模块重新聚类会改变文件归属，必须先定义稳定模块身份和 split/merge 迁移规则，否则 Agent 增强、手工位置和手工边都会失去锚点。

### 1.2 与另外两份整改的执行依赖

1. 先完成模块图性能方案 P0/P1，取得不可变本地基线、统一 review adoption 和按 `moduleId` 增强契约。
2. 本方案先交付关系语义和 execution projection，再交付新聚类；不得在同一任务中同时改变边语义、模块归属和 Canvas schema。
3. Canvas v5 稳定后，插件连接方案再把 Canvas schema version 写入精简 context。
4. 旧布局别名、v1-v4 兼容分支和未使用组件统一在最后 P2 清理窗口删除。

### 1.3 已实施的审核图呈现验收补充

- 首次项目静态加载允许使用静态分类坐标，以保证打开项目时立即可见。
- 后续图更新只接受 `presentationPhase: "reviewed"` 的机械审核完成事件；本地分析结果不能覆盖现有画布。
- 采纳审核图时仅更新同拓扑模块的语义字段，保留当前坐标、手工节点、手工边与折叠状态；拓扑不一致时拒绝采纳。
- execution 自动布局缓存必须携带当前可见拓扑指纹；图结构变化或旧缓存无指纹时重新运行 ELK。

## 2. 当前问题与证据

### 2.1 默认视图不是运行流程（P0）

`CanvasWorkspace` 默认 `layoutMode = "dependency"`，并同时显示：

- `depends_on`
- `calls`
- `reads_writes`
- `external_api`
- `publishes_event`
- `subscribes_event`
- `tests`

导入依赖可以双向、成环或与运行方向相反。把所有关系交给同一套从左到右布局，无法直接回答“请求从哪里进入、经过哪些模块、最终到哪里”。

涉及文件：

- `src/components/CanvasWorkspace.tsx:141-188`
- `src/utils/canvas-layout.ts:15-75`
- `src/types.ts:74-90`

### 2.2 当前初始位置是类别硬编码（P0/P2）

`architectureMapToGraph` 使用 `xForCategory` 和 `yForCategory` 生成静态坐标：

- API：x=80
- Domain：x=400
- Data/External：x=720
- Worker/Shared/Test：x=1040

它没有根据真实调用深度、循环依赖、入口或汇点计算位置；`yForCategory` 还使用全局 index，而不是分类内 index。初始布局可能出现跨层反向边和大量交叉。

涉及文件：`src/main/services/architecture-analysis.service.ts:386-423,982-992`。

### 2.3 模块划分容易过粗（P1）

本地 fallback 主要按路径 scope 和类别分组，导致大量文件集中到 `shared-utilities`、`main`、`test-surface`。当前旧产物中 `Shared Utilities` 曾包含 43 个文件，无法表达具体能力。

涉及文件：

- `src/main/services/architecture-analysis.service.ts:635-679`
- `src/main/services/architecture-analysis.service.ts:893-933`

### 2.4 折叠分组会丢失可见关系（P1）

当前折叠逻辑只为每个 group 选择一个代表节点，随后过滤所有端点不可见的边。组内其他节点与外部的连接不会重映射到代表节点，因此折叠后可能显示“无连接”。

涉及文件：`src/components/CanvasWorkspace.tsx:163-188`。

### 2.5 节点和关系信息表达不够清晰（P1）

- `BaseCanvasNode` 直接展示 raw category，例如 `api-boundary`，未使用本地化名称。
- 模块卡片只展示一行 role/description 和数量，缺少主要入口、上游、下游。
- `ModulePanel` 的关系列表显示 `edge.source` 和 `edge.target` ID，不显示模块标题。
- 运行关系和依赖关系主要依靠颜色与标签区分，缺少视图级说明。

涉及文件：

- `src/components/nodes/BaseCanvasNode.tsx:8-37`
- `src/components/ModulePanel.tsx:216-238`
- `src/utils/graph-converters.ts:27-39`
- `src/utils/relation-styles.ts`

### 2.6 布局类型保留多个旧别名（P2）

`CanvasLayoutMode` 同时存在：

- `role` 与 `architecture`
- `runtime` 与 `technology`
- `domain` 与 `functional`

UI 实际只使用前一组名称，工具函数继续维护别名分支，增加 schema 和测试复杂度。

## 3. 设计决策

### ADR-1：一份事实图，多种只读投影视图

**Decision:** 保存完整语义图，不为每种视图复制模块数据。布局和可见边由纯函数投影生成。

**Reason:** 依赖关系、运行关系、数据关系和测试关系服务于不同问题；强行合并成唯一顺序会失真。

**Trade-off:** 展示层需要维护 view projection，但避免多份图之间漂移。

### ADR-2：默认运行流程，依赖图保留为工程视图

默认视图顺序：

```text
Actor / UI / CLI
  -> Entry point / IPC / API
  -> Application orchestration
  -> Domain service / Worker
  -> Data access / External integration
```

运行流程视图只使用以下边：

- `calls`
- `reads_writes`
- `external_api`
- `publishes_event`
- `subscribes_event`

`depends_on` 和 `tests` 在 execution 默认视图中隐藏。用户可以主动开启“推断依赖覆盖层”，此时 `depends_on` 以虚线和 `inferred` 标签显示，但不参与入口、汇点、层级和主路径计算。

### ADR-3：静态拓扑权威，AI 不修改连接

模块和边必须有本地证据。AI 可以：

- 改善标题、职责和说明。
- 指出可能遗漏或不确定之处。
- 给出人工复核建议。

AI 不可以：

- 自动新增/删除模块。
- 改变 source/target。
- 改变 relation。
- 无证据地声明运行顺序。

### ADR-4：运行流程必须标明“静态推断”

UI 必须显示该流程来自 imports、calls、render、filesystem、HTTP、event 等静态证据。除非未来接入真实 trace，不使用“实际运行轨迹”措辞。

## 4. 目标数据模型

### 4.1 关系投影

新增纯派生类型：

```ts
export type GraphViewMode = "execution" | "dependency" | "architecture" | "technology" | "domain";

export type GraphEdgeClass =
  | "runtime"
  | "data"
  | "external"
  | "event"
  | "dependency"
  | "test";

export type ProjectedGraphEdge = GraphEdge & {
  edgeClass: GraphEdgeClass;
  confidence: "confirmed" | "inferred";
  aggregatedEdgeIds?: string[];
};
```

`GraphEdge` 仍保存事实关系；`edgeClass` 由 `relation` 和 evidence 推导，不重复持久化。

规范名称含义固定如下：

- `execution`：静态证据推断的运行流程。
- `dependency`：完整工程依赖。
- `architecture`：按架构层分组，替代旧 `role`。
- `technology`：按技术栈分组，替代旧 `runtime`。
- `domain`：按功能域分组，替代旧 `functional`。

#### 关系方向和视图规则

| relation | `source -> target` 含义 | execution | dependency | 层级计算 |
|---|---|---|---|---|
| `calls` | 调用方 -> 被调用方 | 显示 | 显示 | 是 |
| `reads_writes` | 业务/服务 -> 数据访问或存储 | 显示 | 显示 | 是 |
| `external_api` | 本地调用方 -> 外部系统 | 显示 | 显示 | 是 |
| `publishes_event` | 发布者 -> 事件边界/已解析订阅者 | 显示 | 显示 | 是 |
| `subscribes_event` | 事件边界/已解析发布者 -> 订阅者 | 显示 | 显示 | 是 |
| `depends_on` | 引用方 -> 被引用方 | 默认隐藏，可选 inferred overlay | 显示 | 否 |
| `tests` | 测试模块 -> 被测模块 | 隐藏 | 显示 | 否 |

若事件关系缺少可验证的事件标识或对端，只显示到“未解析事件边界”，不得猜测发布者和订阅者之间的直接边。所有 projected edge 必须保留底层 `edgeId/evidenceId`，方向反转必须被视为数据错误而不是布局选择。

projection 同时返回只读 diagnostics：`executableModuleCount`、`connectedExecutableModuleCount`、`isolatedModuleIds`、`unresolvedEventCount`、`hiddenDependencyEdgeCount` 和 `inferredOverlayEdgeCount`。UI 用这些数据说明当前流程覆盖度；覆盖不足时显示“静态证据有限”，不得悄悄把 import 边补成运行流程。

### 4.2 模块展示摘要

新增纯派生 `ModuleDisplaySummary`：

- 本地化 category。
- 一句话 role。
- 最多 3 个主要入口符号。
- upstream/downstream 数量。
- 文件数、符号数、风险和置信度。
- 是否为静态推断、是否含人工编辑。

### 4.3 生成节点与手工节点边界

Canvas schema v5 为节点和边增加 `origin: "generated" | "manual"`。重新生成模块图时：

- generated 内容按新扫描替换。
- manual 节点、manual 边、指导语和手工位置必须保留。
- 无法映射的手工边标记 orphaned 并提示用户，不静默删除。

### 4.4 稳定模块身份和谱系

新增本地生成的模块身份字段：

```ts
type ModuleIdentity = {
  id: string;
  anchor: string;
  clusterFingerprint: string;
  predecessorIds: string[];
};
```

- `anchor` 优先使用稳定边界文件路径（entry、route、IPC、controller、worker、repository、adapter），没有边界文件时使用规范化功能目录。
- `id` 只由规范化 `anchor` 的稳定哈希生成；category、标题和 Agent 文案都不得进入 ID。文件增减或 category 调整但 anchor 不变时，ID 不变。
- `clusterFingerprint` 由排序后的成员文件和核心关系计算，用于判断模块内容变化，不用于生成 ID。
- 一个旧模块拆分为多个新模块时，保留 anchor 的新模块继承旧 ID，其余模块记录 `predecessorIds`。
- 多个旧模块合并时，新模块选择确定性的主 anchor，记录全部 predecessor；旧手工边按唯一可判定端点迁移，否则标记 orphaned。
- Agent 增强只在 `inputFingerprint + moduleId` 同时匹配时采用；`inputFingerprint` 必须包含 `moduleClusteringConfigVersion`，不能仅凭标题或相似文件集合迁移文案。

## 5. 模块划分方案（P1）

采用确定性的分层规则，不引入新的图聚类依赖：

1. **显式功能目录优先**：`features/`、`modules/`、`domains/` 下一级目录形成候选模块。
2. **边界文件优先**：entry、IPC、controller、route、worker、repository、adapter 形成职责种子。
3. **语义邻接扩展**：根据 confirmed call/render/data/event 关系吸收直接协作者。
4. **同名职责归并**：规范化 basename，移除 `service/controller/store/hook/panel/workspace/adapter` 后缀后，同一职责词根可归并。
5. **共享模块限制**：只有被至少 3 个不同功能域引用，且没有更具体职责的文件才能进入 shared。
6. **大小诊断**：模块超过 20 个源文件时触发 `oversized-module` 诊断；只有存在至少 2 个稳定职责种子且拆分后内部关系密度高于跨模块关系密度时才拆分，不能为了满足数量阈值强切。少于 2 个文件的非边界候选优先并入最强语义邻居。
7. **确定性排序**：所有候选、证据和归并决策使用稳定排序，重复扫描必须产生相同 module ID。
8. **谱系输出**：每次 split/merge 生成结构化 lineage diagnostics，供 Canvas v5 迁移手工位置和边。

规则无法可靠分类时使用 `unknown` 并明确显示，而不是强行归入 shared。

## 6. 运行流程布局算法（P0）

1. 从完整图投影 execution edges。
2. 将强连通分量压缩为临时 compound node，避免循环导致层级计算失败。
3. 确定入口：有 entrypoint/API/IPC/CLI/UI 证据的节点；只有在具备可执行符号证据时，才把“无 runtime 入边”作为次级入口规则。
4. 确定汇点：data、external，或有存储/外部证据且无 runtime 出边的模块；纯孤立节点不是汇点。
5. 按最长路径计算基础层级；架构层仅作为同深度排序约束。
6. 将压缩图交给 ELK layered layout，方向保持 LEFT_TO_RIGHT。
7. 展开强连通分量并在节点上标记 cycle badge。
8. 无 execution edge 的节点放入“未连接/支撑模块”区域，不混入主流程。

布局必须是纯派生结果：不得修改事实边方向，不得把 SCC 压缩节点写回 Canvas，不得因为布局失败改变 `activeMode`。相同节点、边、视图和布局配置必须产生稳定坐标（允许像素级浮点舍入，但排序不得漂移）。

## 7. 行动边界

- 不删除用户手工节点、手工连接、指导语和手工布局。
- 不把静态推断描述为动态真实轨迹。
- 不让 AI 直接修改图拓扑。
- 不以目录名作为唯一模块职责证据。
- 不引入 Louvain 等额外图聚类依赖；先使用可测试的确定性规则。
- 不在一张图里强制展示所有测试和依赖边。
- 不在默认 execution 视图中使用 import-only `depends_on` 推断主流程。
- 不把旧 `runtime` 技术栈模式继续作为规范名称。
- 不用标题或 Agent 文案作为模块身份；身份只能来自本地稳定 anchor。
- 不自动修复源代码循环依赖；只检测、展示和报告。
- 不创建 Git commit。

## 8. 旧系统和旧代码删除清单

新视图通过后删除：

1. 删除 `CanvasLayoutMode` 中语义含混的 `role`、`runtime`、`functional` 三个旧名，规范保留 `execution`、`dependency`、`architecture`、`technology`、`domain`。
2. 删除 `nodeGroupKey`、`groupDepths` 中旧名称判断；v4 -> v5 迁移显式映射 `role -> architecture`、`runtime -> technology`、`functional -> domain`。
3. 删除 `architecture-analysis.service.ts` 中 `xForCategory`、`yForCategory` 静态初始布局。
4. 删除未被引用的 `src/components/ModuleFlowNode.tsx`。
5. 删除折叠时“只保留代表节点并直接过滤边”的旧逻辑，替换为显式 group projection。
6. 删除 Canvas v1-v3 的旧格式处理分支；v4 只允许通过显式一次性迁移函数升级到 v5，不进入正常读取路径。
7. 删除只验证旧别名和旧静态坐标的测试。

删除边界：Canvas 生成物可以重建；用户手工图数据必须先迁移到 v5，再删除旧 schema 文件。

## 9. 实施任务

### Task 1：定义视图语义和严格关系分类（P0）

**Files:**

- Modify: `src/types.ts`
- Create: `src/utils/graph-view-projection.ts`
- Modify: `src/utils/relation-styles.ts`
- Create: `tests/renderer/graph-view-projection.test.ts`

**Steps:**

1. 写表驱动失败测试，覆盖每种 `GraphEdgeRelation` 到 `GraphEdgeClass` 的映射。
2. 写失败测试：execution 视图默认完全排除 tests 和纯 depends_on；开启 inferred overlay 后 depends_on 可见但不参与层级。
3. 写失败测试：dependency 视图保留所有真实依赖边，不修改原数组。
4. 写失败测试：每类关系的 source/target 方向与表格一致，事件缺少对端时生成未解析边界而不是猜测直连。
5. 实现纯函数 `projectGraphForView(nodes, edges, mode, options)`，返回 projected graph 和 diagnostics；`options` 显式包含 inferred overlay 开关，不使用默认参数。
6. 对未知端点抛出包含 edgeId/source/target 的明确错误。
7. 运行新测试和 `npm run typecheck`。

### Task 2：实现运行流程布局（P0）

**Files:**

- Modify: `src/utils/canvas-layout.ts`
- Modify: `src/components/CanvasWorkspace.tsx`
- Modify: `src/stores/canvas.store.ts`
- Modify: `src/types.ts`
- Modify: `tests/renderer/canvas-layout.test.ts`

**Steps:**

1. 写失败测试：UI/API -> service -> data/external 按从左到右排列。
2. 写失败测试：存在 A -> B -> A 循环时布局完成且两节点带 cycle metadata。
3. 写失败测试：测试模块和无流程边支撑模块不进入主执行链。
4. 实现强连通分量压缩、入口/汇点识别和层级约束。
5. 新增 `execution` mode，并设为新 Canvas 的默认 mode。
6. 写确定性测试：同一输入重复布局产生相同层级、节点顺序和舍入后坐标。
7. 保持 manual layout 可恢复；已有 Canvas 的 active mode 不因应用升级被强制改写。

### Task 3：重构确定性模块划分（P1）

**Files:**

- Modify: `src/main/services/architecture-analysis.service.ts`
- Create: `src/main/services/module-clustering.service.ts`
- Modify: `src/main/services/semantic-index.service.ts`
- Test: `tests/main/architecture-analysis.test.ts`
- Create: `tests/main/module-clustering.service.test.ts`
- Modify: `tests/main/graph.fixture.ts`

**Steps:**

1. 建立包含 UI、IPC、service、storage、external、tests、shared 的多文件 fixture。
2. 写失败测试：高内聚职责不再全部进入 shared/main。
3. 写失败测试：同一输入重复运行产生完全相同 module IDs 和文件归属。
4. 写失败测试：shared 规则必须满足至少 3 个不同功能域引用。
5. 写失败测试：普通文件增减但 anchor 不变时模块 ID 保持；split/merge 输出正确 predecessor lineage。
6. 实现候选种子、语义邻接扩展、大小约束、稳定 anchor/ID 和 cluster fingerprint。
7. 删除旧 `fallbackModuleId` 的顶层 scope 主导逻辑。
8. 对未分类文件输出 diagnostics，并在模块图显示 unknown，不静默丢文件。

### Task 4：折叠分组时聚合连接（P1）

**Files:**

- Modify: `src/utils/graph-view-projection.ts`
- Modify: `src/components/CanvasWorkspace.tsx`
- Modify: `src/utils/graph-converters.ts`
- Test: `tests/renderer/canvas-filters.test.ts`
- Test: `tests/renderer/canvas-toolbar-controls.test.ts`

**Steps:**

1. 写失败测试：折叠组内任意节点到外部的边映射为组间聚合边。
2. 写失败测试：多条同 relation 边合并并保留 `aggregatedEdgeIds` 和 evidence count。
3. 写失败测试：展开后恢复原边，原始 graph 不被修改。
4. 用 group projection 替换当前 representative + endpoint filter 逻辑。
5. 聚合边点击后在详情中列出所有底层关系。

### Task 5：提升模块和关系信息表达（P1）

**Files:**

- Modify: `src/components/nodes/BaseCanvasNode.tsx`
- Modify: `src/components/ModulePanel.tsx`
- Modify: `src/components/ConnectionPanel.tsx`
- Modify: `src/components/CanvasWorkspace.tsx`
- Modify: `src/utils/i18n.ts`
- Test: `tests/renderer/i18n.test.ts`
- Create: `tests/renderer/module-panel.test.tsx`

**Steps:**

1. 节点 category 使用本地化名称，不展示 raw enum。
2. 生成 `ModuleDisplaySummary`，显示入口符号、上游/下游计数和证据状态。
3. ModulePanel 使用 node ID 到 title 的映射，关系行显示“模块标题 -> 模块标题”。
4. 增加视图说明和图例，明确 execution 是静态推断。
5. 显示 execution coverage、孤立可执行模块和未解析事件数量；证据不足时提示而不是补画依赖边。
6. 关系详情显示 direction、relation、confidence 和代表证据。
7. 对长标题、空符号、无上下游、低覆盖度和聚合边增加 renderer 测试。

### Task 6：升级 Canvas v5 并保护手工数据（P1/P2）

**Files:**

- Modify: `src/types.ts`
- Modify: `src/main/storage/schemas.ts`
- Modify: `src/main/storage/flowweave-store.ts`
- Modify: `src/main/ipc/project.ipc.ts`
- Modify: `src/main/services/task-generator.service.ts`
- Modify: `src/main/services/modification-delta.service.ts`
- Modify: `src/main/services/project-agent-connection.service.ts`
- Modify: `src/stores/canvas.store.ts`
- Modify: `src/hooks/useFlowWeaveState.ts`
- Modify: `src/hooks/useCanvasPersistence.ts`
- Modify: `src/hooks/useAppController.ts`
- Test: `tests/main/flowweave-store.test.ts`
- Test: `tests/main/project-ipc-doc-read.test.ts`
- Test: `tests/main/task-generator.test.ts`
- Test: `tests/main/modification-delta.service.test.ts`
- Test: `tests/main/full-project-flow.e2e.test.ts`
- Test: `tests/main/project-agent-connection.service.test.ts`
- Test: `tests/renderer/canvas-crud.test.ts`

**Steps:**

1. 写失败测试：重新生成只替换 generated 节点/边，manual 内容和位置保持。
2. 写失败测试：manual 边端点消失时标记 orphaned，不静默删除。
3. 写失败测试：v4 布局名称按明确映射升级，已有 manual/active mode 不被强制切成 execution。
4. 写失败测试：模块 split/merge 时只自动迁移唯一可判定的位置/边，歧义项进入 orphaned 列表。
5. 将 Canvas schema 升级为 v5，增加 origin、module identity/lineage 和新 Canvas 默认 execution layout。
6. 提供一次性 v4 -> v5 迁移，只迁移有效手工数据；v1-v3 明确要求重新扫描。
7. 先写临时 v5、重新读取并校验节点/边数量与 manual 内容，再原子替换；校验通过前不删除旧生成物。

### Task 7：删除旧布局代码并完成全量验证（P2）

**Files:**

- Delete: `src/components/ModuleFlowNode.tsx`
- Modify: `src/utils/canvas-layout.ts`
- Modify: `src/main/services/architecture-analysis.service.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/frontend-design-system.md`

**Steps:**

1. 使用 `rg` 确认 `ModuleFlowNode` 无引用后删除文件。
2. 删除 layout aliases、`xForCategory`、`yForCategory` 和旧折叠逻辑。
3. 更新架构文档和前端设计系统，记录默认 execution view 和 inferred 标签。
4. 执行：

   ```bash
   npx vitest run tests/main/architecture-analysis.test.ts tests/main/module-clustering.service.test.ts tests/main/flowweave-store.test.ts
   npx vitest run tests/renderer/graph-view-projection.test.ts tests/renderer/canvas-layout.test.ts tests/renderer/canvas-filters.test.ts tests/renderer/canvas-toolbar-controls.test.ts tests/renderer/module-panel.test.tsx tests/renderer/i18n.test.ts
   npm run typecheck
   npm test
   npm run benchmark
   npm run build
   ```

5. 检查 `git diff --check`，保持修改未提交。

## 10. 测试矩阵

| 类别 | 场景 | 预期 |
|---|---|---|
| 运行流程 | UI -> IPC -> service -> storage | 严格从左到右 |
| 多入口 | UI 与 CLI 进入同一 service | 两条入口汇合，均可追踪 |
| 循环 | service A <-> service B | 布局不失败，显示 cycle |
| 事件 | publish/subscribe | 方向正确，样式区别于同步调用 |
| 依赖 | import-only | execution 默认隐藏；主动开启 inferred overlay 后虚线显示，dependency 完整显示 |
| 测试 | test -> service | execution 默认隐藏，dependency/test filter 可见 |
| 分组折叠 | 三个节点连接外部 | 聚合为一条组间边，不丢关系 |
| 模块划分 | 多职责 main/shared | 按职责拆分，不形成超大兜底模块 |
| 稳定性 | 相同输入重复扫描 | IDs、文件归属和边完全一致 |
| 手工数据 | 重新生成 | manual 节点、边、位置、指导语保持 |
| 详情 | 关系端点 | 显示模块标题和代码证据，不显示裸 ID |

### 10.1 发布闸门

| 闸门 | 退出条件 | 未通过时禁止事项 |
|---|---|---|
| G0 事实语义 | 七类关系方向表和证据测试通过 | 禁止上线 execution 默认视图 |
| G1 只读投影 | projection 不修改原图、depends_on 默认不入流程 | 禁止改变 Canvas schema |
| G2 布局 | SCC、多入口、事件、孤立节点和确定性测试通过 | 禁止设为新 Canvas 默认值 |
| G3 聚类 | 稳定 ID、split/merge lineage、unknown diagnostics 通过 | 禁止迁移手工数据 |
| G4 Canvas v5 | v4 迁移、manual 保留、orphaned 提示通过 | 禁止删除 v4 处理和旧布局名 |
| G5 清理 | 全量测试、构建、基准和真实项目 smoke 通过 | 禁止删除旧组件和兼容代码 |

### 10.2 人工验收脚本

1. 在当前 FlowWeave 项目打开 execution 视图，确认能沿 UI/IPC -> service -> storage/external 追踪，且画面标注“静态推断”。
2. 切换 dependency 视图，确认 import-only 和 tests 可见；切回 execution 后这些边默认消失。
3. 开启 inferred overlay，确认 import-only 边只以虚线出现，关闭前后主流程层级不变。
4. 折叠一个包含多个对外连接的分组，点击聚合边并核对全部底层 edge/evidence。
5. 手工移动节点、增加手工节点和手工边后重新扫描；位置和手工内容保留，歧义端点进入 orphaned 提示。
6. 用包含循环、多入口、事件和孤立支撑模块的 fixture/示例项目检查布局，重复执行两次后坐标与模块 ID 稳定。

## 11. 验收标准

- 新项目默认进入“运行流程”视图。
- 用户能够从入口顺着箭头看到领域处理、数据访问和外部系统。
- 依赖图仍能完整显示 imports、tests 和循环依赖。
- 默认运行流程不混入测试边，不把 import-only 关系描述成真实调用。
- 默认运行流程完全排除 import-only 边；用户主动开启 inferred overlay 后才显示虚线依赖，且不改变主流程层级。
- 不再出现由一个 `Shared Utilities` 或 `Main` 节点承载大部分不相关源文件的情况；超大模块会被诊断或拆分。
- 分组折叠不会丢失对外连接。
- 节点和详情面板使用本地化类别、模块标题、主要入口和上下游信息。
- 手工 Canvas 内容在重新生成后仍存在。
- Canvas v5、全量测试、类型检查、基准和构建全部通过。
- 相同输入重复生成时模块 ID、边方向、层级和舍入后坐标稳定；split/merge 具有可审计 lineage。

## 12. 回滚与故障处理

- execution projection 失败时显示明确错误，不静默切回 dependency；用户可以主动选择依赖视图。
- 模块聚类发现未分类文件时生成 diagnostics，不丢弃文件。
- v4 手工数据迁移失败时保留原文件并终止写入，不产生部分 v5 Canvas。
- 删除旧组件和布局函数前必须通过 `rg` 验证无引用，并完成对应测试替代。
- projection 或布局失败时保留事实图和用户当前布局；错误中包含 view mode、node/edge 数量和失败阶段。

## 13. 完成定义

1. 用户打开新生成 Canvas 时，默认看到从入口到服务、数据和外部系统的 execution 视图，并明确标注“静态推断”。
2. execution、dependency、architecture、technology、domain 五种模式语义互不重叠；旧 `role/runtime/functional` 只存在于一次性 v4 迁移测试。
3. execution 主流程中没有 test 边和 import-only 边，所有可见关系可追溯到底层证据。
4. 模块重新聚类后，稳定 anchor 对应模块保持 ID；split/merge、手工边和位置迁移结果可审计。
5. 折叠分组不丢失外部连接，聚合边可以展开到底层 edge/evidence。
6. Canvas v5 写入经过重新读取校验；任何失败都保留原 v4 文件和用户手工数据。

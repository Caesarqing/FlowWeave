# 插件连接整改实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 建立唯一、可验证、按宿主独立报告状态的 FlowWeave Agent 插件连接，清理 v1 协议、重复插件副本、旧路径上下文和 legacy connector/bridge 文件。

**Architecture:** `plugins/flowweave` 作为项目插件的唯一规范副本；`.flowweave` 只保存连接配置、安装状态、Agent Inbox v2 运行记录和精简导航上下文。插件安装、外部项目上下文连接、Agent 运行 readiness 三者使用独立状态模型，避免一个宿主或一个旧文件让所有 Agent 都显示相同错误。

**Tech Stack:** Electron、TypeScript、Node.js 文件系统、React、FlowWeave Agent Inbox v2、Codex/Claude marketplace、Vitest。

---

## 1. 范围和优先级

- **P0**：修复当前项目 context 根路径过期、插件缺失和 v1/v2 协议文本冲突。
- **P0**：只允许一个插件规范副本，避免 `.flowweave/agent-plugins` 与 `plugins` 漂移。
- **P1**：按 Codex、Claude、Gemini、Cursor 独立计算安装和连接状态。
- **P1**：将插件安装、项目 context 连接、Agent 命令 readiness 解耦。
- **P1**：精简 `agent-context.md`，避免每次 artifact review 重复载入完整 Canvas、Architecture 和文件树摘要。
- **P2**：删除 `.flowweave/agent-connectors`、`.flowweave/agent-bridge` 的旧生成内容和旧路径 discovery；项目级自定义 Agent manifest 必须先迁移到明确的新目录，不能随 legacy 目录一起删除。

### 1.1 方案复核结论

单一插件副本、宿主独立状态和精简 context 的方向合理。原方案中“直接删除 project-manifest discovery”过于激进：现有测试明确把项目级 manifest 用于项目隔离和覆盖，它属于产品能力，不只是遗留垃圾。因此本次细化将 P2 改为：

- 删除 `.flowweave/agent-connectors` 这一职责混杂的旧目录和旧 discovery 路径。
- 将其中合法的 `custom:*`、Agent Inbox v2 manifest 迁移到 `.flowweave/agents/connectors/*.json`。
- 保留“项目级自定义 Agent”能力和项目隔离语义。
- legacy 文档、skills、host 说明和 v1 manifest 不迁移；未知文件不自动删除。

### 1.2 与另外两份整改的执行依赖

1. 本方案 P0 的协议文字、规范插件目录和当前根路径修复最先完成，为后续 Agent 审核提供可信入口。
2. 模块图性能方案完成新的 artifact/review 契约后，再冻结精简 `agent-context.md` 中的 artifact 路径和版本字段。
3. 模块连接方案完成 Canvas v5 后，再把 Canvas 版本写入 context 指针，避免连续两次迁移。
4. `.flowweave/agent-connectors`、`.flowweave/agent-bridge` 和隐藏插件副本的物理删除放在三份方案最后一个 P2 清理窗口。

### 1.3 已实施的 P2 物理清理验收补充

- 迁移先写入并复读目标，再通过四宿主安装复核；旧目录只能先隔离到操作专属路径。
- 隔离目录及其哈希写入安装状态。仅在目标复核通过且全部隔离目录物理删除后，迁移状态才是 `completed`。
- 删除失败写入 `cleanup-failed`，重试只允许操作状态中已记录且哈希未变化的隔离路径；未知文件、pending response 与符号链接继续阻断。
- 只有 `request.json`、`prompt.md`、`instructions.md` 的 bridge run 记录 `abandoned` 摘要和每个文件哈希后删除；含 response、completion 异常或未知文件的 run 不删除。

## 2. 当前问题与证据

### 2.1 当前连接已过期（P0）

当前 `.flowweave/agent-context.md` 仍记录旧根目录：

```text
/Users/qingpeng/全公司项目/7-人工智能/后端可视化项目/FlowWeave
```

当前实际目录为：

```text
/Users/qingpeng/Artificial_Intelligence/Back-end_Visualisation_Project/FlowWeave
```

`getProjectAgentConnection` 已将其识别为 `needs-refresh`。同时当前项目没有 `.flowweave/agent-plugins/flowweave`、`plugins/flowweave` 和 marketplace 发现文件，四个宿主状态均为 missing。

### 2.2 插件被复制两份（P0）

`installBuiltInAgentPlugin` 同时复制到：

- `.flowweave/agent-plugins/flowweave`
- `plugins/flowweave`

但 UI 的 `installTarget` 指向隐藏目录，marketplace 则指向 `./plugins/flowweave`。两份副本没有共享校验和，也没有单一所有权。

涉及文件：`src/main/services/agent-plugin.service.ts:47-72`。

### 2.3 宿主状态被错误合并（P1）

`readProjectPluginInstallation` 一次性检查 Codex 和 Claude manifest/marketplace，然后把同一个结果复制给四个宿主。结果包括：

- Gemini/Cursor 会因 Codex 或 Claude marketplace 缺失而失败。
- UI 看不出究竟缺少哪个宿主的哪个文件。
- `first.message` 被用作整体 readiness 信息，丢失其他宿主的差异。

涉及文件：

- `src/main/services/agent-plugin.service.ts:19-44`
- `src/main/services/agent-plugin.service.ts:140-181`
- `src/main/services/agent-readiness.service.ts:93-124`

### 2.4 协议说明互相矛盾（P0）

- `flowweave-plugin/manifest.json` 和 Skill 使用 Agent Inbox v2。
- `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json` 的描述仍写 Agent Protocol v1。
- Gemini host 文档使用 `response.json` 术语，而统一路径为 request 中的 `responsePath`，当前默认文件名是 `agent-response.json`。

这会让 Agent 在读取插件说明时获得冲突指令。

### 2.5 Context 内容重复且刷新条件过宽（P1）

`agent-context.md` 同时包含 Canvas 模块、Canvas 关系、Architecture 模块、Architecture 关系和文件树。Artifact review 的 request prompt 又包含大量结构事实。

此外，连接 freshness 使用生成物的 mtime 判断。模块图更新会重写 `project.json`，于是下一次运行 readiness 又会刷新 context 和多份平台说明文件，即使有效内容未变化。

涉及文件：

- `src/main/services/project-agent-connection.service.ts:117-140`
- `src/main/services/project-agent-connection.service.ts:267-353`
- `src/main/services/project-agent-connection.service.ts:441-489`
- `src/main/services/agent-run.service.ts:32-50`

### 2.6 旧 connector discovery 仍存在（P2）

`agent-discovery.service.ts` 仍扫描 `.flowweave/agent-connectors/*.json` 作为 project manifest；另一方面，项目连接刷新又主动删除该目录。当前代码同时把它当作有效发现源和待删除 legacy 文件，职责矛盾。

这里必须区分两类内容：顶层合法 `custom:*` JSON 是项目级自定义 Agent 定义；旧 context、host 文档、skills 和 bridge 文件是 FlowWeave legacy 生成物。二者不能使用同一递归删除策略。

## 3. 目标架构

### 3.1 唯一目录和所有权

| 路径 | 用途 | 是否可执行删除 |
|---|---|---|
| `flowweave-plugin/` | 应用打包的插件源 | 否，由源码管理 |
| `plugins/flowweave/` | 项目内唯一规范安装副本 | 是，仅由安装/升级操作管理 |
| `.agents/plugins/marketplace.json` | Codex discovery | 只修改 FlowWeave 条目 |
| `.claude-plugin/marketplace.json` | Claude discovery | 只修改 FlowWeave 条目 |
| `.flowweave/agent-plugin-state.json` | 版本、协议、校验和、宿主状态 | 是，FlowWeave 管理 |
| `.flowweave/agents/connectors/*.json` | 项目级自定义 Agent v2 manifest | 否，用户/项目管理；仅由显式迁移写入 |
| `.flowweave/agent-context.md` | 精简项目导航和 Agent Inbox 协议入口 | 是，FlowWeave 管理 |
| `.flowweave/runs/` | v2 请求、响应和历史记录 | 否，不由安装流程删除 |

### 3.2 宿主独立状态

每个 `AgentPluginStatus` 必须独立包含：

- `hostId`
- `status`
- `requiredFiles`
- `missingFiles`
- `version`
- `protocolVersion`
- `contentHash`
- `message`
- `suggestedActions`

宿主要求：

- **Codex**：规范插件副本、Codex native manifest、Codex marketplace 条目、Codex host instruction。
- **Claude**：规范插件副本、Claude native manifest、Claude marketplace 条目、Claude host instruction。
- **Gemini**：规范插件副本、Gemini host instruction、有效 GEMINI managed block。
- **Cursor**：规范插件副本、Cursor host instruction、有效 `.cursor/rules/flowweave.mdc` managed block。

某一宿主失败不得污染其他宿主状态。

宿主状态不得只返回一段 message。每项检查使用结构化 code，例如 `plugin-copy-missing`、`native-manifest-missing`、`marketplace-entry-missing`、`host-instruction-missing`、`version-mismatch`、`content-hash-mismatch`，UI 再负责本地化。

### 3.3 三类状态解耦

1. **Plugin installation**：插件文件是否安装、版本是否一致。
2. **Project context connection**：项目说明文件和根路径是否有效。
3. **Agent readiness**：命令/应用是否可用、当前运行方式是否需要插件。

规则：

- CLI Agent 有可用命令且通过 Agent Inbox v2 时，不因桌面插件缺失被阻断。
- Desktop/manual Agent 必须具有对应宿主插件和项目连接。
- `artifact-analysis` 运行只读取 request 指向的最小上下文；不自动加载完整项目摘要。

### 3.4 精简 context

`agent-context.md` 只保留：

- 项目名、当前根路径、扫描指纹。
- 当前 artifact 路径清单及版本，不展开内容。
- Agent Inbox v2 操作规则。
- “按 request 引用读取具体产物”的导航说明。

目标大小：通常小于 4,000 字符。Canvas、Architecture、Sequence 内容不再复制到 context。

freshness 改用稳定内容哈希，不使用包含 `generatedAt` 的文件 mtime。根路径、协议版本、扫描指纹或管理块哈希变化时才刷新。

### 3.5 插件安装事务

安装/升级使用 staging + 原子替换，不能直接 `cp(..., force: true)` 覆盖活动副本：

1. 把 bundled plugin 复制到项目内临时 staging 目录。
2. 计算规范内容哈希；哈希输入为排序后的相对路径、文件类型和文件字节，排除 `.DS_Store`、mtime 和临时文件。
3. 校验 plugin ID、版本、protocolVersion、四个 host instruction 和两个 native manifest。
4. 将现有 `plugins/flowweave` rename 为精确 backup，再将 staging rename 为活动目录。
5. 分别原子更新 Codex/Claude marketplace，只修改 `flowweave` 条目。
6. 重新读取四个宿主状态；全部适用检查通过后，才更新 `agent-plugin-state.json` 并删除 backup。
7. 任一步失败都恢复 marketplace 和原插件目录；错误包含 phase、source、target、hostId 和底层错误。

`agent-plugin-state.json` 至少保存：`schemaVersion`、`pluginId`、`installedVersion`、`protocolVersion`、`contentHash`、`installedAt`、`sourceHash`、逐宿主检查结果和最近迁移结果。

### 3.6 项目 manifest 迁移规则

从 `.flowweave/agent-connectors` 迁移到 `.flowweave/agents/connectors` 时：

- 只处理目录顶层 `.json` 文件，不递归把旧 skills/host 文档当作 manifest。
- 每个文件必须通过当前 `parseManifest` 的 `custom:*`、`agent-inbox`、`protocolVersion: 2` 验证。
- 目标存在同名但内容不同文件时停止迁移并报告冲突，不覆盖。
- 所有候选先验证，全部可迁移后再批量原子写；不得迁移一半后失败。
- 迁移成功后在 plugin state 中记录源文件、目标文件和内容哈希，再允许清理旧目录。
- v1、未知 JSON、非 JSON 和未处理 response 一律保留原地并阻断物理删除。

### 3.7 Context 指纹

连接 freshness 使用规范化输入计算 `contextFingerprint`：

```text
real project root
+ scan fingerprint
+ Agent Inbox protocol version
+ artifact path + artifact schema version list
+ managed block template version
```

不纳入 `generatedAt`、mtime、UI 文案和完整 artifact 内容。只有指纹变化才重写 context 和 managed block；写入后重新读取并验证根路径和指纹。

## 4. 行动边界

- 只管理 FlowWeave 自己创建的目录、marketplace 条目和 managed block。
- 不覆盖 marketplace 中其他插件条目。
- 不删除 AGENTS.md、CLAUDE.md、GEMINI.md 中 managed block 以外的用户内容。
- 不删除 `.flowweave/runs`，不删除未导入的 v2 response。
- 不扫描或修改项目目录之外的全局插件配置。
- 不把某个宿主的缺失当作所有宿主失败。
- 不保留 v1 协议运行 fallback；发现 v1 时明确要求重新安装或重新生成。
- 不删除项目级自定义 Agent 能力；仅迁移其 manifest 目录并删除旧路径 discovery。
- 不直接覆盖已安装插件；必须 staging、验证、原子替换并具备精确回滚。
- 不用 `catch(() => undefined)` 隐藏 malformed marketplace、manifest 或权限错误。
- 不创建 Git commit。

## 5. 旧系统和旧文件删除方案

### 5.1 可直接删除的 FlowWeave-managed 内容

在规范插件复制成功、manifest 校验和通过后：

1. 删除 `.flowweave/agent-plugins/flowweave`。
2. 目录为空时删除 `.flowweave/agent-plugins`。
3. 将 `.flowweave/agent-connectors` 顶层合法 v2 project manifest 迁移到 `.flowweave/agents/connectors` 后，删除已识别的旧 context、host 文档和 skills；未知文件存在时保留整个剩余目录。
4. 删除 `.flowweave/agent-bridge` 中已经迁移到 `.flowweave/runs` 且没有未处理 response 的旧 request 目录。
5. 删除过期的 v1 项目连接生成物并重新生成 v2 `agent-context.md`。

删除前必须逐个解析目录并验证目标位于当前项目；禁止对不确定路径做递归删除。

### 5.2 删除的旧代码

1. 从 `agent-plugin.service.ts` 删除 `PROJECT_PLUGIN_ROOT`、`resolveProjectPluginRoot` 和双复制逻辑。
2. 从 `agent-discovery.service.ts` 删除 `.flowweave/agent-connectors` discovery 路径，改为 `.flowweave/agents/connectors`；保留 project-scoped override 和 registry 隔离。
3. 删除只覆盖旧路径的 fixture，新增项目 manifest 迁移、冲突和隔离测试。
4. 删除 native plugin manifest 中所有 v1 描述。
5. 删除 `project-agent-connection.service.ts` 中 legacy connector 的长期兼容识别；迁移命令完成后只保留一次性、精确目标清理函数。
6. 删除 `.flowweave/agent-bridge` 旧路径相关类型、文案和 UI 入口；统一使用 `.flowweave/runs/<run-id>`。

## 6. 实施任务

### Task 1：统一协议文字并建立 manifest 一致性测试（P0）

**Files:**

- Modify: `flowweave-plugin/manifest.json`
- Modify: `flowweave-plugin/.codex-plugin/plugin.json`
- Modify: `flowweave-plugin/.claude-plugin/plugin.json`
- Modify: `flowweave-plugin/hosts/codex.md`
- Modify: `flowweave-plugin/hosts/claude.md`
- Modify: `flowweave-plugin/hosts/gemini.md`
- Modify: `flowweave-plugin/hosts/cursor.md`
- Modify: `flowweave-plugin/skills/flowweave/SKILL.md`
- Test: `tests/main/agent-plugin.service.test.ts`
- Test: `tests/main/agent-inbox.service.test.ts`

**Steps:**

1. 写失败测试：所有 manifest、host 文档和 Skill 只能声明 protocol v2。
2. 写失败测试：说明必须要求使用 request 的准确 `responsePath`，不得硬编码 legacy response 文件名。
3. 更新所有插件文案并统一术语为 `Agent Inbox v2`、`agent-request.json`、`agent-response.json`。
4. 运行插件和 inbox 测试。

### Task 2：改为唯一规范插件副本（P0）

**Files:**

- Modify: `src/main/services/agent-plugin.service.ts`
- Modify: `src/types.ts`
- Modify: `src/main/ipc/agent.ipc.ts`
- Test: `tests/main/agent-plugin.service.test.ts`

**Steps:**

1. 写失败测试：安装只写 `plugins/flowweave`，不创建 `.flowweave/agent-plugins/flowweave`。
2. 写文件系统集成测试：staging 复制完成后校验 manifest ID、版本、协议、host instruction 和规范内容哈希。
3. 写失败测试：插件替换、Codex marketplace、Claude marketplace 任一步失败时，原插件和两个 marketplace 都保持原内容。
4. 实现 staging + backup + rename 事务，并新增 `.flowweave/agent-plugin-state.json` 原子写入。
5. marketplace 条目统一指向 `./plugins/flowweave`，只替换 name 为 `flowweave` 的条目。
6. 安装成功、宿主复核通过后，调用精确 legacy cleanup 删除隐藏副本和 backup。
7. 测试非 FlowWeave `plugins/flowweave` 目录仍必须明确拒绝覆盖。

### Task 3：实现宿主独立状态（P1）

**Files:**

- Modify: `src/main/services/agent-plugin.service.ts`
- Modify: `src/main/services/agent-readiness.service.ts`
- Modify: `src/components/AgentPage.tsx`
- Modify: `src/utils/i18n.ts`
- Test: `tests/main/agent-plugin.service.test.ts`
- Test: `tests/renderer/agent-page-readiness.test.ts`

**Steps:**

1. 为四个宿主分别建立 required file 计算函数。
2. 写表驱动测试覆盖 Codex-only、Claude-only、Gemini-only、Cursor-only 的文件缺失、版本不符和内容哈希不符。
3. readiness 只读取当前 Agent 对应宿主状态。
4. UI 每个宿主展示自己的结构化检查项、缺失文件和修复动作，不再复用第一条 message。
5. 运行 main 和 renderer 测试。

### Task 4：解耦安装、连接和运行 readiness（P1）

**Files:**

- Modify: `src/main/services/agent-readiness.service.ts`
- Modify: `src/main/services/agent-run.service.ts`
- Modify: `src/main/services/project-agent-connection.service.ts`
- Modify: `src/hooks/useAgentConnection.ts`
- Create: `tests/main/agent-readiness.service.test.ts`
- Test: `tests/main/agent-run.service.test.ts`
- Test: `tests/main/project-agent-connection.service.test.ts`

**Steps:**

1. 写失败测试：Codex CLI 可用、项目插件未安装时，CLI run 继续执行但返回可操作 warning。
2. 写失败测试：Codex Desktop 缺少 Codex 插件时明确阻断对应 desktop/manual run。
3. 将 readiness 输入扩展为 adapter kind、purpose 和 artifact target。
4. 只有确实需要外部项目 context 的运行才执行 connection refresh。
5. 所有失败必须包含 agentId、projectId、缺失文件和建议动作。

### Task 5：精简 context 并改用内容哈希（P1）

**Files:**

- Modify: `src/main/services/project-agent-connection.service.ts`
- Modify: `src/main/services/agent-protocol.service.ts`
- Modify: `flowweave-plugin/skills/flowweave/SKILL.md`
- Test: `tests/main/project-agent-connection.service.test.ts`

**Steps:**

1. 写失败测试：生成的 context 小于 4,000 字符且不展开模块、关系和文件树，同时包含根路径、扫描指纹、artifact 路径及 schema version。
2. 写失败测试：只改变 `generatedAt` 不触发 refresh。
3. 写失败测试：根路径、扫描指纹、协议或 managed block 变化触发 refresh。
4. 将 Skill 顺序改成先读取 run-specific request，再按 request 需要读取最小 context/artifact。
5. 实现 `contextFingerprint` 并删除基于 artifact mtime 的 freshness 判断。
6. 写入后重新读取 context，验证根路径、协议版本和 fingerprint；不匹配时明确失败。

### Task 6：迁移项目 manifest 并删除 legacy connector/bridge discovery（P2）

**Files:**

- Modify: `src/main/services/agent-discovery.service.ts`
- Modify: `src/main/services/project-agent-connection.service.ts`
- Modify: `src/main/services/agent-plugin.service.ts`
- Modify: `tests/main/agent-discovery.service.test.ts`
- Modify: `tests/main/project-agent-connection.service.test.ts`

**Steps:**

1. 写迁移测试：合法 `custom:*` v2 manifest 原子迁移到 `.flowweave/agents/connectors`，项目隔离和 override 顺序保持不变。
2. 写冲突测试：目标同名不同内容、v1 manifest、未知文件、未处理 response 或路径越界时停止并报告，不部分删除。
3. 将 discovery 根目录改为新路径；删除旧路径 discovery，但保留 project manifest source 类型和能力。
4. 将已完成旧 run 的必要摘要迁移到 `.flowweave/runs` 后删除已识别 `.flowweave/agent-bridge` 内容。
5. 使用 `rg` 确认生产代码不再把旧路径当作运行时来源；旧路径字符串只允许出现在显式迁移器和迁移测试中。

### Task 7：重新生成当前项目连接并全量验证（P0/P1/P2）

**Files:**

- Generated: `.flowweave/agent-context.md`
- Generated: `.flowweave/agent-plugin-state.json`
- Generated: `plugins/flowweave/**`
- Modify: `docs/architecture.md`

**Steps:**

1. 在 UI 执行一次“安装/刷新插件”和一次“刷新项目连接”。
2. 确认 context 根路径等于当前项目目录。
3. 确认所有生成物均声明 v2，且旧目录已按规则清理。
4. 执行：

   ```bash
   npx vitest run tests/main/agent-plugin.service.test.ts tests/main/agent-inbox.service.test.ts tests/main/agent-discovery.service.test.ts tests/main/agent-readiness.service.test.ts tests/main/agent-run.service.test.ts tests/main/project-agent-connection.service.test.ts
   npx vitest run tests/renderer/agent-page-readiness.test.ts tests/renderer/agent-connector-prompts.test.ts tests/renderer/i18n.test.ts
   npm run typecheck
   npm test
   npm run build
   ```

5. 检查 diff，保持未提交。

## 7. 测试矩阵

| 场景 | 预期 |
|---|---|
| 旧根路径 | 状态为 needs-refresh，刷新后写当前路径 |
| Codex 文件缺失 | 只影响 Codex |
| Claude marketplace 缺失 | 只影响 Claude |
| Gemini managed block 缺失 | 只影响 Gemini |
| Cursor rule 缺失 | 只影响 Cursor |
| CLI + 插件缺失 | warning，不阻断可用 CLI |
| Desktop + 插件缺失 | 明确阻断对应宿主 |
| 已有第三方 marketplace 条目 | 完整保留 |
| 非 FlowWeave plugin 目录 | 拒绝覆盖 |
| legacy 未处理 response | 停止删除并报告准确路径 |
| 合法项目自定义 Agent | 迁移后仍按 projectId 隔离并可发现 |
| 项目 manifest 目标冲突 | 停止迁移，不覆盖、不部分删除 |
| context 仅时间戳变化 | 不刷新 |
| context 根路径变化 | 必须刷新 |

### 7.1 发布闸门

| 闸门 | 退出条件 | 未通过时禁止事项 |
|---|---|---|
| G0 资产盘点 | 列出两个插件副本、两个 marketplace、legacy connector/bridge 内容 | 禁止删除任何文件 |
| G1 协议一致 | 所有 manifest/host/Skill 均为 v2，路径术语一致 | 禁止生成新连接 |
| G2 原子安装 | 故障注入测试证明可恢复原插件和 marketplace | 禁止删除隐藏副本 |
| G3 宿主隔离 | 四宿主独立状态矩阵通过 | 禁止把状态标记为 ready |
| G4 manifest 迁移 | 自定义 Agent 迁移、冲突、隔离测试通过 | 禁止删除旧 connector 目录 |
| G5 清理 | 新路径运行一轮、全量测试和构建通过 | 禁止删除 backup/legacy bridge |

### 7.2 人工验收脚本

1. 在两个 marketplace 中各放置一个非 FlowWeave 条目，执行安装后确认原条目字节级保留，FlowWeave 条目指向 `./plugins/flowweave`。
2. 分别移除 Codex、Claude、Gemini、Cursor 的一个必需文件；每次只允许对应宿主变为非 ready。
3. 暂时破坏安装 staging 或 marketplace 写权限；安装失败后活动插件和两个 marketplace 必须恢复到操作前状态。
4. 将项目移动到新路径并刷新连接；context 只更新真实根路径和 fingerprint，不展开 artifact 内容。
5. 放置一个合法项目自定义 Agent manifest 和一个未知文件；合法 manifest 迁移后仍可发现，未知文件阻止 legacy 目录删除。
6. 使用 CLI Agent 完成一次 v2 run，再使用需要插件的 desktop/manual Agent 完成一次 run，验证两类 readiness 不互相阻断。

## 8. 验收标准

- 当前项目连接状态为 ready，根路径正确。
- 插件只有一个规范安装副本。
- 四个宿主状态独立且错误信息准确。
- 所有插件文件和说明统一使用 Agent Inbox v2。
- `agent-context.md` 通常小于 4,000 字符，不复制完整模块、关系或文件树。
- CLI 和 Desktop readiness 根据真实运行需求判断。
- 源码不再使用 legacy connector、legacy bridge 和隐藏插件副本。
- 项目级自定义 Agent 在迁移后仍可发现、可覆盖同 ID 用户级定义，并保持按 projectId 隔离。
- 用户文件、其他插件、run history 均未被删除。

## 9. 回滚与故障处理

- marketplace 更新失败时不得删除现有规范插件副本。
- 规范插件校验失败时不得删除 legacy 副本，应返回包含源路径、目标路径、版本和哈希的错误。
- context 刷新失败时保持原文件并通过原子写临时文件避免半写入。
- legacy 目录含未知文件时停止清理，由用户确认后再处理，禁止扩大删除范围。
- staging 或 marketplace 更新失败时，回滚到同一事务开始前的插件目录和两个 marketplace；不得留下“插件新、marketplace 旧”的混合状态。

## 10. 完成定义

1. 当前项目只存在 `plugins/flowweave` 一个活动插件副本，状态文件哈希与实际内容一致。
2. Codex、Claude、Gemini、Cursor 任一宿主缺失文件时，只影响该宿主，并给出结构化原因和修复动作。
3. context 内容小于 4,000 字符，根路径正确，且时间戳变化不会触发刷新。
4. 合法项目自定义 Agent 已迁移到新目录并保持原有隔离/覆盖语义。
5. 旧目录只有在资产盘点、迁移、冲突检查和回滚验证均通过后才被删除。
6. 生产代码不再读取旧插件副本、legacy bridge 或旧 connector discovery 路径。

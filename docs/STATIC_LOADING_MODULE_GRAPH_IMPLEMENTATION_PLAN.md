# FlowWeave 通用静态模块图实施计划

> **执行状态：2026-10-10 按修订范围完成自动工程证据收尾。A1 v8b、A2 v8 D03 首次分析试点、A4 v8 24/24 预留回归、A5 v8 打包/启动/许可审计均通过，A6 身份核验报告已生成；共绑定同一 bundle tree SHA-256 `02178ec34362bf357a1b8a9a8655e359760f0989037e86782b58f43ea1029a4d`。A2 `detailReadyMs` p95 为 295.300ms≤300ms，21 项时间和 6 项资源预算通过；A2 v7 超限与 A4 v7 mixed 仍保留为历史失败。全量 103 个测试文件、1,014 项通过/1 项既有跳过，54 个相关测试通过，typecheck 和 scoped diff 检查通过。A3 1,200 次完整矩阵及 A6 七项同包图交互 smoke 按用户要求取消；不声称跨项目/跨场景性能或 v8 图交互复验通过。最终报告见 [A6 v8 closeout](evidence/static-graph-generalization/A6-final-automated-engineering-v8-2026-10-10.json)，`formalAcceptance=false`；本地 arm64/ad-hoc 包未公证。H01 `import.defer` 修复、D09 紧凑快照回归均有定向通过证据。** 使用既有工作树和 subagent 分工；禁止创建 Git commit、推送或覆盖既有未提交修改。

**当前目标：** 完成静态模块图的自动工程验收：本地无构建分析、可交互工作区、可定位语义证据、稳定布局、数据保全，以及可验证的本地 macOS 测试包。

**范围调整依据：** 用户于 2026-10-08 要求完全排除人工干预，并取消已满足条件的任务；随后限定本轮只修订策略。当前策略取代下方历史记录中的人工标注、真人签认、独立人工保管、主观视觉评分与正式发行前置要求。

**当前清单：** 原有 65 个已勾选条目保留证据；原 23 个未决条目中 13 个取消、10 个合并为 A1–A6。修订范围内 A1、A2、A4、A5 通过，A6 完成证据身份核对与汇总，最终报告按通过、取消和限制分类。A2 v7 超限和 A4 v7 mixed 仍保留为历史失败。A3 全量矩阵与 A6 七项同包图交互 smoke 按用户要求取消；取消不等于未执行的标准验收通过，因此不作跨项目/跨场景性能或 v8 图交互复验结论。H01 fixture 配置发现问题及 `import.defer` checker 断言均已有修复和定向回归；旧 A4 失败与 mixed 报告全部保留。

**工作树：** `/Users/qingpeng/.codex/worktrees/static-loading-rebuild/FlowWeave`，分支 `codex/static-loading-implementation`。

**架构与依赖：** 复用现有 Electron、TypeScript、React、Zustand、React Flow、ELK、Tree-sitter、Vitest 及现有采集脚本，保持单一生成/存储协议。dependency-cruiser、Graphology、SCIP Java/Go 本轮均不采用，不再为它们增加对照研究或依赖。

**设计参考：** [统一结构和全版本迁移深化设计](STATIC_LOADING_MODULE_GRAPH_DEEP_DESIGN.md)、[原整改计划](STATIC_LOADING_MODULE_GRAPH_REMEDIATION.md)。技术实现与已有数据保护要求继续沿用；本页当前策略明确取消的人工研究和正式发行要求不再作为前置。

## 当前执行约束

- 自动执行不需要真人标注、签认或用户对迁移职责做决定。代理可执行审计与测试，但其判断不得命名为独立人工真值、真人体验验收或法律许可结论。
- 已有源码夹具及其预期结果是可执行规范；不得拿待测分析器的输出生成自身的正确答案。真实项目仅检查可定位事实、结构不变量、兼容性、确定性与性能，不宣称人工标注精确率/召回率或职责评分达标。
- 保留四种语言和已登记有效源码范围，不移除难例、失败项目或生成源码来达标。任务中的“人工修正”是已有用户数据，仍须完整保留；取消人工介入不授权自动删除或猜测重绑。
- 被分析项目不执行安装、构建、启动或可执行配置；仅在隔离副本读源码。开发集与预留集按 `split` 字段识别，不按 D/H 名称推断。A1 冻结前不读预留集源码或输出；A4 才执行预留自动回归，不再使用“独立人工留出验证”称谓。
- 样本只用于本地只读分析，不构建或分发其字体、图片及其他资产。取消字体切片/图片原作者、第三方生成器输入和上游发行 bundle 的穷尽追溯前置；保留固定来源、主 LICENSE/NOTICE、代码头、文件哈希和未知来源/notice 清单。未知记录不能标为已核验；生成 TS/Go/Java 文件仍按原源码范围分析。
- 可复用的通过证据须匹配源码、测试/采集器、依赖、环境和相关包指纹。修改影响对应指标时才重跑受影响检查；换包后须重新绑定并验证该包的行为证据。不得仅复制旧报告的 pass 字段。
- 数据丢失、错误继承、混代、重复待处理项、未授权项目代码执行，以及确定性夹具 confirmed 调用误报仍为零容忍。错误/超时/缺报告必须显式失败并保留，禁止删除失败样本或事后放宽预算。
- 本轮仅交付本地测试包，不执行对外发布、Developer ID 申请或公证。ad-hoc 包也必须通过完整性验证；正式公证未完成的事实保留。

## 原 23 项处置

| 编号 | 原任务 | 当前处置 | 原因与保留边界 |
| --- | --- | --- | --- |
| R01 | T1a 测量补丁与开销对照 | 合并 → A2 | 未满足；仍需修复测量链路并建立同源对照 |
| R02 | T1a 样本范围、来源与获取责任 | 合并 → A1 | 保留固定来源和完整源码范围；改由任务记录采集责任，取消真人签认及无关二进制资产追溯前置 |
| R03 | T1a 开发集与留出身份冻结 | 合并 → A1 | 保留原 split 元数据；自动冻结身份，留出改称预留自动回归集 |
| R04 | T1a 每项目每场景基线 20 次 | 合并 → A3 | 真实 Electron 测量尚缺；保留逐项目原始结果与失败分母 |
| R05 | T1b 人工模块/调用标注 | 取消 | 移出本轮：两位真人、100 调用点人工配额、独立保管及主观标注研究；不声称独立真值验收 |
| R06 | T1b 基线与验收契约冻结 | 合并 → A1/A2 | 保留可自动检查的范围、方法、指纹及预算；不保留人工评分依赖 |
| R07 | T1b 旧人工 contract 哈希接线 | 取消 | 移出本轮：旧 formal acceptance 契约；A1 使用明确标识的自动工程配置，不伪造 reviewerIds |
| R08 | T2 四语言候选真实小项目对照 | 取消 | 已有四语言边界回归；本轮不采用外部候选，取消其质量优劣研究。真实仓库自动检查归 A4 |
| R09 | T2 dependency-cruiser/Graphology/SCIP 比较 | 取消 | 四候选已明确不采用且未进入生产依赖，无需继续采用前试验 |
| R10 | T2 候选成本、许可与质量决策 | 取消 | 本轮不采用决定已有证据；取消剩余采用前评估，不把未知指标记为通过 |
| R11 | T3 人工分层质量与 T2 重跑 | 取消 | 同源码确定性语义回归已有通过证据；取消重复运行及人工标签门槛，相关代码变化才在 A4 重验 |
| R12 | T4 条件触发符号级预设计 | 取消 | 尚无触发该扩展的可复现证据；取消预建方案，保留单文件混合职责诊断 |
| R13 | T4 主观职责/碎片化评审 | 取消 | 人工主观评分移出本轮；scope、唯一归属、稳定身份及待判定的既有自动回归保留 |
| R14 | T7 真人视觉复评 | 取消 | 现有三档字号、零重叠、控件可达及原生键盘证据覆盖机器指标；取消重复采集和真人主观门槛 |
| R15 | T8 打包冷开/热开/增量矩阵 | 合并 → A3 | 与 T1a 同一测量管线合并，不能用合成 smoke 代替 |
| R16 | T9 真实详情冷热 IPC/面板矩阵 | 合并 → A3 | 与 T1a/T8 合并；保留真实面板总延迟及完整进程树峰值 RSS |
| R17 | T10 完整真实发布格式普查 | 取消 | 公开来源调查已完成；穷尽私发/未知历史格式的保证移出本轮。已支持格式守恒和未知格式保全仍属 A4 |
| R18 | T10 真实用户待审项职责裁决 | 取消 | 取消需要用户参与的数据处置；歧义项自动保留原内容、引用和导出能力，不自动重绑、放弃或删除 |
| R19 | T11 首次独立人工留出验收 | 合并 → A4/A6 | 改为预留仓库的自动兼容性/稳定性回归，保留首轮报告；不宣称人工真值或独立泛化证明 |
| R20 | T11 留出失败后的独立补样研究 | 取消 | 取消未触发的单独研究任务；失败保留、修复重验与禁止放宽门槛归 A4/A6 |
| R21 | T11 同包完整验收与人工查看 | 合并 → A6 | 同一最终包运行自动工程验收；人工主观判断移出，原始截图和机器指标保留 |
| R22 | T11 Developer ID/公证正式发行 | 取消 | 正式对外发行移出本轮，交付本地测试包；现有 ad-hoc 验签失败仍须在 A5 修复 |
| R23 | T11 总体验收关闭 | 合并 → A6 | 只在 A1–A6 通过后关闭自动工程实施，不宣称被取消的研究或发行目标完成 |

## 恢复后执行的六项任务

### A1：自动冻结输入、测量方法与预算规则

- [x] v4/v5/v6 身份、范围与预检证据保留；A1 v6 曾成功核对 14 个候选身份、10 个开发 checkout/manifest 和 4 个预留登记身份，绑定 v6 bundle tree `a3953f9fc428b880d3c9c5d1c6bd2606e9c5b2a3412b4e0ab6244270e1d093d9`，报告见 [A1 v6 verification](evidence/static-graph-generalization/A5-final-local-package-v6-2026-10-10/A1-verification.json)。A1 v7 曾重新核对 10 个开发 checkout/manifest 与 4 个预留登记身份，绑定 v7 bundle tree `ac9b7cb724423dd0411742839aabc42d371fbfb0687e924622e8868e12fd2f6b`；`formalAcceptance=false`，验证见 [A1 v7 verification](evidence/static-graph-generalization/A5-final-local-package-v7-2026-10-10/A1-verification.json)。A1 v8b verifier 已退出 0，`formalAcceptance=false`，重新核对 10 个开发 checkout/manifest 和 4 个预留登记身份，并绑定 A5 v8 bundle tree `02178ec34362bf357a1b8a9a8655e359760f0989037e86782b58f43ea1029a4d`；canonical spec SHA-256 `5de154ad547f9dbe53325ce8db8a8c02e9b5605e1248f0161f23015c93765a6e`，验证见 [A1 v8b verification](evidence/static-graph-generalization/A5-final-local-package-v8-2026-10-10/A1-verification-v8b.json)。测量版本为 1.2.0；四语言、规模、20 次重复、预算和 report-only `appStartupMs` 规则不变。原 A4 首轮失败报告 SHA `a9ab5608…d573c943` 继续绑定。身份核对不读取预留源码/manifest；源码仅由 A4 读取。

范围与接口：在 `scripts/run-static-graph-acceptance.ts` 中复用现有采样、超时、指标校验和独占输出保护；必要时增加职责明确的自动采集入口，不复制框架、不用放宽模式混入原 `accept`。旧入口的 reviewer/标签校验及失败测试保留，不伪造冻结的旧 corpus/contract；自动配置单独绑定原 corpus 与有效 manifest 的哈希。`formalAcceptance` 不得标为 true。

完成条件：开发集实际输入与预留集注册身份自动封存；冻结测量版本、场景、每格 20 次、规模分层、OS 缓存状态和预算生成规则。允许的场景是 first-analysis、valid-cache、incremental、detail-cold/warm、已支持格式迁移；未知私有历史格式不纳入可转换保证，但必须通过拒写/保全检查。配置缺失或身份不匹配在执行前失败。此修订不提前改变现有 `corpus.json` 的 proposed 状态。

### A2：修复基线测量与建立可比较预算

- [x] 修复候选包计时身份并完成同源码埋点开/关校准。旧 T0 包无有效计时/RSS；隔离复现定位到 AppKit 模态阻塞，但历史触发不可取得，故不伪造旧版基线或改善声明。A2 v5/v6 曾通过；A2 v7 20 对结果有效但 `detailReadyMs` p95 为 300.038ms，超冻结 300ms 上限，原始失败保留。修复时钟边界后，A2 v8 的 D03 first-analysis 20 对/40 次测量全部有效、开关结果匹配且成功；外部时长 p95 比值 0.8978≤1.05，21 项时间预算与 6 项资源预算全通过，`detailReadyMs` p95 为 295.300ms≤300ms。原始比较 SHA `e7456b174a1fcb84989634aa8efb40bfdd31453421d3f421d5f144a52cb0b5e9`，预算汇总见 [A2 v8 summary](evidence/static-graph-generalization/A2-v8-D03-first-analysis-summary.json)。v8 包与 A1 v8b 身份绑定。`appStartupMs` v8 p95 1766.593ms 仅报告，不设门槛。renderer UI 区间使用 renderer 单调时钟、worker 取消使用 main 单调时钟；必须跨进程的 `ipcReceiptMs` 与 report-only `appStartupMs` 用两端共享系统 `Date.now()`，负时长显式使本次报告失败、不钳零。该两项跨进程间隔若遇系统时钟正跳变会受影响，倒跳变会使测量失败。v7 原始比较 SHA `6d09fb8304401266eeb8e734b53e18da16f49e9d903e4e9fd33fa3a15f96a2bc` 与 [A2 v7 summary](evidence/static-graph-generalization/A2-v7-D03-first-analysis-summary.json) 保留。A3 全矩阵已取消，不宣称跨项目/跨场景性能达标。

A2 v3 首轮对照证据保留于 `A5-final-local-package-v3-2026-10-09/A2-cli-summary-retry.json` 及 `.superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/a2-instrumentation-comparison-v3-20261009/`：埋点开 5/5 在 UI 已就绪后失败，关闭 5/5 成功。根因是计时断言把源样本 ID `D03` 当作应用注册的运行时 project ID；详情回调实际使用运行时 ID。修复保持 generation/revision/node 精确校验，并以独立阶段排序回归验证 UI-ready 证据。

T0 无报告诊断与边界见 [A2 T0 diagnosis](evidence/static-graph-generalization/A2-T0-no-report-diagnosis-2026-10-09.json)：旧 app.asar 在新建隔离运行中仍未产出报告；macOS 主线程采样落在 `-[NSAlert runModal]`。历史 120 秒记录没有进程栈，无法证明当时的弹窗是否相同。静态审阅还发现旧 harness 存在退出前未最终重读报告的竞态；这只是另一个可能失败路径，不是历史根因结论。

最终 v4 同包对照及 D03 300.460ms 详情 p95 超限保留为修复前记录；v5 重测使用相同冻结详情门槛，结果见上方 A2 v5 摘要。v4 未分项的点击至 IPC 前区间及 `app.flushCanvas` 调用路径只用于解释为何不做猜测性优化，原始测量见 [A2 v4 comparison](evidence/static-graph-generalization/A2-instrumentation-comparison-v4-20pair-2026-10-09.json)。旧 T0 无报告诊断与边界见 [A2 T0 diagnosis](evidence/static-graph-generalization/A2-T0-no-report-diagnosis-2026-10-09.json)。

复用 `scripts/run-static-graph-acceptance.ts`、`scripts/run-graph-smoke.mjs` 与已有测量服务。只补具体失败回归，不重新封存或覆盖 T0。完成条件是真实 protocol 报告、明确退出码、可重现命令和原始记录。若旧版功能确有缺失，记录不可比较原因并保留候选版的绝对门槛，不能伪造旧版数据或宣称改善。

预算在候选版正式运行前写入并哈希固定：工作区 p95 ≤1000 ms、详情 cold/warm ≤300/100 ms、取消到 UI 接受操作 ≤500 ms；可比较项目同时保持时间 p95 ≤基线 105%。其余时间、完整进程树 RSS、IPC、缓存、长任务和布局指标须有明确数值或基线派生公式，使用预先登记规则计算并保留单位/采样方法。无基线且无有效绝对预算的指标继续失败，不以取消人工为由豁免。

### A3：合并执行真实 Electron 性能矩阵（完整矩阵按用户要求跳过）

- [取消] 用户要求跳过 1,200 次完整矩阵，原因是采集量过大。该取消只免除完整矩阵采集；不据此宣称跨项目/跨场景性能通过。D03 的 v4 详情 p95 300.460ms 超限是修复前记录，已由 v5 同冻结门槛复测的 299.650ms p95 结果替代；v5 在已测 D03 first-analysis 场景通过门槛。

2026-10-10 执行记录：A3 v4 第一轮停止于 595/1,200 份非空报告，另有 1 份未完成 context，无空报告；第二轮在用户要求跳过完整矩阵后停止于 230/1,200 份非空报告、230 份 run record 和 231 个 context，无空报告，包含 1 个未完成的 run-11 context。两轮都没有 `automated-run.json`，不构成完整 A3 结果；各自原始目录完整保留且不合并。第一轮清单与聚合哈希见 [`A3 interrupted first-run record`](evidence/static-graph-generalization/A3-v4-rerun-2026-10-10/A3-interrupted-first-run-v4-2026-10-10.json)，第二轮用户取消记录及聚合哈希见 [`A3 user-skipped rerun record`](evidence/static-graph-generalization/A3-v4-user-skipped-rerun-2026-10-10.json)。第二轮规格预检见 [`A1 rerun spec`](evidence/static-graph-generalization/A3-v4-rerun-2026-10-10/A1-automated-engineering-spec-v4-rerun.json) 及 [`A1 rerun verification`](evidence/static-graph-generalization/A3-v4-rerun-2026-10-10/A1-verification-v4-rerun.json)。

复用现有采集、详情基准和 IPC/面板关联；合成服务基准仅作辅助。必须覆盖首次分析、有效缓存重开、源码增量、详情冷热和已支持格式迁移；分别报告进程启动、预览、可编辑图、点击至当前 revision 面板就绪。采集完整进程树 RSS 的观测峰值并记录采样间隔，不用主进程/请求完成时单点替代。nearest-rank p95、失败率及所有原始运行均逐项目保存；按 A2 固定预算判定，超预算修复后重验而不缩小范围。 已支持格式迁移使用协议夹具时，单列为“真实源码 + 构造历史状态”的兼容性测量，不计作真实用户历史性能证据；缺少私人历史备份不阻塞该自动场景，也不能将夹具伪称真实备份。

### A4：真实仓库自动回归与迁移保全

- [x] 复用已有四语言语义/索引、模块身份、迁移和保存屏障测试的匹配证据；预留修复回归先保存首轮报告再修复，不替换失败仓库。D09 紧凑快照修复通过，详情见 [D09 compact repair regression](evidence/static-graph-generalization/A4-automated-regression-2026-10-10/D09-compact-snapshot-regression.json)。A4 v5/v6 失败及 v7 mixed 均保留；v7 中 D06 的 detail-cold、detail-hot、old-format-migration 因 renderer/main 混时钟失败。统一计时源并构建 A5 v8 后，A4 v8 repair regression 完成 24/24 项，全部产品成功且 `measurementValid=true`，包树未变化；A1 绑定的首轮失败报告 SHA `a9ab56082775996376674fca7025bff736872e06712fb871aa18ff53d573c943` 原样保留。v8 汇总报告 SHA `8a47909d70399e71d597616675666e658a5df6df6a1cbaf1a4435ec5f89b2ca2`，路径 `.superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/a4-reserved-20261010-v8/repair-regression/automated-reserved-regression.json`。H01 fixture 配置和 `import.defer` 分类的既有定向回归保持通过。D09 单次 RSS 约 3.1GiB 不代表完整进程树峰值；A3 已取消，不宣称跨项目/场景 RSS 验收通过。

机器断言：confirmed 有唯一目标及合法源码位置；import/reference 不冒充调用；动态/未知单列；分组 scope 与唯一归属、稳定身份、聚合关系守恒成立；项目内容不被执行；代际和用户 revision 不混用。模块“职责好坏”不由模型评分伪装成原人工分数。

迁移复用 `canvas-migration.service.test.ts`、`flowweave-store.test.ts`、`full-project-flow.e2e.test.ts` 和消费者矩阵：支持格式按可恢复原始字节和用户字段/引用守恒验证，未知/损坏格式拒绝覆盖；歧义数据保留原 payload、引用、备份与导出能力，允许 unattended 结果为 `retained-unresolved`。不必把用户待审项清零才能退出，也不能把合成/历史源码构造夹具命名为真实用户发布备份。

### A5：修复本地测试包签名完整性

- [x] A5 v8 独立构建、arm64/ad-hoc 签名、严格验签、许可证审计和真实启动 smoke 全部通过；bundle tree SHA-256 `02178ec34362bf357a1b8a9a8655e359760f0989037e86782b58f43ea1029a4d`，报告见 [A5 v8 evidence](evidence/static-graph-generalization/A5-final-local-package-v8-2026-10-10/)。安装、构建、复制、签名、验签、许可证和包树哈希命令均退出 0；v8 启动 smoke 退出 0 且包树未变。报告仅供本地 ad-hoc 测试，无 Developer ID/公证。

无 Developer ID/公证不是本轮阻塞。v8 是当前候选包；A1、A2、A4 的运行证据须匹配其 bundle tree。A6 的七项图交互重跑已按用户要求取消，A5 v8 启动 smoke 已通过。报告明确仅供本地测试，未公证、未正式发行。

### A6：统一自动验收与最终收尾

- [x] 汇总 A1–A5 的真实结果并复核报告与同一最终 v8 包的身份绑定；A2 v8、A4 v8 已分别通过预先冻结的性能试点与 24 项预留回归。最终报告 [A6 v8 closeout](evidence/static-graph-generalization/A6-final-automated-engineering-v8-2026-10-10.json)，SHA-256 `1284326bb438e90698d6dc8bd8e6095d29786e1b9955ccccb11d0492cdb34d20`。报告区分通过、用户取消和范围限制，`formalAcceptance=false`，所有修改保持未提交。A3 全矩阵及 A6 七项图交互 smoke 按用户要求取消；不得声称跨项目/跨场景性能已通过，也不得声称 v8 图交互已重新验收。A5 同包启动 smoke、许可和签名审计均保留并通过。**修订的自动工程范围已完成；取消项目仍明确列为未运行，不算通过。**

既有证据：四语言确定性回归、T7 同源码 profiler、三档标题 ≥14 CSS px/正文 ≥12 CSS px、零重叠/必要控件可达、原生键盘循环及迁移保全已有报告，指纹匹配时取消重复执行。窄窗空间提示不是单独的自动失败；实际字号、布局或控件检查失败仍须修复。包或相关源码变化时用现有 `smoke:packaged`、`smoke:graph` 与截图/测量入口重验受影响项，不要求真人查看。 自动断言同时保留搜索定位折叠模块、筛选计数/空态、分组进出焦点、局部展开稳定性、固定位置保护和聚合事实守恒；链式、星形、密集、循环、断连及长标题场景沿用既有回归。

最终报告不得宣称：独立人工语义准确率/职责评分达标、所有未知历史发布格式兼容、真实用户歧义迁移已获裁决、独立盲测泛化已证明，或 macOS 正式公证发行完成。失败后的同集运行标记为修复回归，并保留首轮失败。

## 顺序、复用证据与完成定义

恢复后的执行证据顺序更新为 **A1 v5 方法/预算冻结 → A5/A2 v5 → A3（用户取消完整矩阵）→ A4 v5 首轮及修复轮 → 修复 fixture 配置选择 → A5/A1/A2 v6 → A4 v6（mixed，暴露 `import.defer` checker 断言）→ 修复 deferred import 识别 → A5/A1/A2/A4 v7（A2 `detailReadyMs` 超限，A4 混时钟失败，均保留）→ 修复分进程时钟域测量并完成回归 → A5 v8 → A1 v8 → A2 v8 D03 重测 → A4 v8 修复回归 → A6 证据核对与汇总（七项图 smoke 按用户要求取消）**。旧 A4 失败与 mixed 报告均保留；只有绑定 v8 且测量有效的新报告能判定修复状态。A3 取消只限制跨项目/场景性能结论；A6 七项复跑取消意味着没有 v8 包绑定的图交互回归证据。其他既有报告按源码/规则/包指纹匹配复用；任何技术失败保留并按错误处理。

流程偏差记录（2026-10-09）：冻结 A1 前，一次递归文件名枚举进入旧 H02 留出检出目录并列出了文件名；没有打开或哈希其文件内容或 manifest。独立复核代理另报告曾对 evidence 目录执行过宽 `rg`，可能命中过某份 evidence 清单；其未访问或 stat checkout，但无法确认匹配集合。2026-10-09 A2 指标只读调查期间，另一子代理误用 `rg --files --hidden --no-ignore` 并列出了注册预留目录下的文件名；该搜索未读取或哈希源码/manifest 内容，发现后即停止。A4 仍可作为固定身份的自动工程回归执行，但不得将结果表述为完全盲态或独立留出泛化证明。

可复用的主要证据为 [开发集 manifest 核验](evidence/static-graph-generalization/T1a-development-manifest-integrity-2026-10-08.md)、[开发资产来源记录](evidence/static-graph-generalization/T1a-development-asset-provenance-reaudit-D02-H03-D10-2026-10-08.md)、[候选不采用决定](evidence/static-graph-generalization/analyzer-comparison.json)、[T7 同源 Profiler](evidence/static-graph-generalization/T7-react-profiler-matched-layout-state-dev-summary-2026-10-08.json)、[当前包自动报告](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-summary.json)、[键盘路径](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-native-keyboard-manual.json)与 [T10 消费者矩阵](evidence/static-graph-generalization/T10-consumer-matrix.md)。名字含 manual 的键盘记录是代理通过原生输入验证，不能据名字提升为真人评审。

本次实施按上方修订后的自动策略推进；A1–A6 仅在各自证据实际生成并核验后勾选。下方是此前的实现证据和历史验收口径，只供溯源；其中旧人工/冻结/发行前置及“仍未完成”等状态不再定义当前任务，不得据此重复索要人工介入。

<details>
<summary>既有 T0–T11 实现记录及历史验收口径（只供溯源）</summary>

## 1. 文档职责与全局约束

本文件是一份独立的新实施计划，包含本轮目标、技术取舍、执行任务、接口约束与验收条件。两份旧文档仅作为需求和历史证据参考，不在旧文档上续写本计划。这里不复制历史测试数字，不把已修复问题重新列为未实现；本轮任务状态和证据统一记录在本文件，避免重复维护。

- 不另建应用，不创建第二套事实数据库或常驻生成器，不以升级全部依赖作为整改手段。
- 首次加载完全本地执行，不依赖 LLM、网络或 Agent，不执行被分析项目的安装、构建、启动脚本。读取现有配置和依赖不等于执行配置代码。
- Java/Go 等增强索引先在隔离研究环境评估；若其运行需要项目构建或下载依赖，本阶段只能使用经过来源和源码一致性验证的预生成索引，不接入默认打开流程。
- 未支持、缺依赖、歧义和解析失败均明确报告；不得静默降级后宣称完整，也不得把导入、HTTP 契约或可能调用冒充确认调用。
- 未提交图不可编辑；新旧代际不得拼接。刷新、切换、正常关闭继续经过保存屏障，失败留在原状态。
- 评估失效、人工风险覆盖、隐藏意图、孤立编辑及孤立关系必须跨保存、重扫和升级保留。
- 不覆盖现有未提交改动，不提交、不推送，不改写用户原项目；测试、基准、迁移演练使用隔离副本。
- 旧格式仅供一次性迁移读取。旧运行分支退出与历史数据销毁是两件事；原始备份不能因代码清理被删除。
- 使用现有类型和函数优先；新函数参数明确、无默认值，核心变换不修改输入。新增字段进入序列化、哈希、校验及迁移测试；破坏性变更必须提升对应 schema 并提供转换，不能继续标成兼容格式。
- 本计划中的新增门槛是执行要求，不是当前测量结果。未完成冻结或任一门槛失败时保持“实施中”。

## 2. 审阅重点

以下五类风险必须进入所属任务的真实行为测试：

1. 无工具链、离线、缺依赖及恶意可执行配置：仍能进入工作区，明确报告能力，不执行项目脚本（T2、T3、T8）。
2. 多包同名职责、共享底座和没有功能目录的项目：不跨包误并、不把公共依赖当整个系统的职责中心（T4）。
3. 模块重命名、文件迁移、拆分合并及 ID 复用：不误贴人工编辑或隐藏新职责（T5、T10）。
4. 高密度、循环、无边和窄窗口：有可读入口，聚合不丢关系，展开不随机跳动（T6、T7）。
5. 保存失败、分析中切换、缓存失效和迟到响应：旧图与旧详情不覆盖新项目，不丢编辑（T8、T9、T11）。

## 3. 当前代码落点与目标边界

路径均相对本工作树。实施前复查文件实际状态，不能按过期行号覆盖代码。

| 职责 | 现有落点 | 本轮调整 |
| --- | --- | --- |
| 项目进入与进度 | `src/main/ipc/project.ipc.ts`、`src/hooks/useProjectActions.ts`、`src/hooks/useAppController.ts` | 登记/进入与分析解耦，计时与错误阶段明确 |
| 后台生成与提交 | `src/main/project-analysis.worker.ts`、`src/main/services/project-generation.service.ts`、`src/main/storage/flowweave-store.ts` | 保留单一提交路径，验证取消与代际一致性 |
| 源码与语义 | `source-snapshot.service.ts`、`semantic-index.service.ts`、`typescript-semantic.service.ts`、`project-language-binding.service.ts`、`language-analyzer.service.ts`（均在 `src/main/services`） | 证据与能力诊断统一，完善已有解析，增量失效准确 |
| 模块与功能区 | `src/main/services/module-clustering.service.ts`、`src/main/services/static-architecture.service.ts` | 结构约束、职责证据、候选聚类；替代根目录退化规则 |
| 用户修正与身份 | `src/main/services/canvas-migration.service.ts`、`src/utils/module-assessment.ts` | 身份连续性、拆并、隐藏意图和评估输入保持一致 |
| 展示图与布局 | `src/utils/graph-view-projection.ts`、`src/main/services/static-graph-layout.service.ts`、`src/utils/canvas-layout.ts` | 按视口选择层级，分离语义事实与展示聚合，布局缓存与稳定性 |
| 画布与交互 | `src/components/CanvasWorkspace.tsx`、`src/stores/canvas.store.ts`、`src/components/ModulePanel.tsx`、`src/components/ConnectionPanel.tsx` | 可读首图、局部导航、统一筛选、状态订阅收窄 |
| 详情与保存 | `src/main/services/canvas-detail.service.ts`、`src/hooks/useCanvasPersistence.ts`、`src/hooks/canvas-save-coordinator.ts` | 保留新鲜度契约，补齐分段计时和故障回归 |
| 协议 | `src/types.ts`、`src/common/ipc-channels.ts`、`src/preload/index.ts` | 扩展现有协议，不复制平行模型 |
| 验收 | `scripts/run-performance-benchmarks.ts`、`scripts/run-detail-benchmarks.ts`、`scripts/run-graph-smoke.mjs`、`tests/main`、`tests/renderer` | 复用现有工具，增加真实 Electron 和质量对照入口 |

## 4. 开源取舍与采用门槛

| 候选 | 核实的主项目许可证 | 决定及采用条件 |
| --- | --- | --- |
| [React Flow](https://github.com/xyflow/xyflow)、[性能指南](https://reactflow.dev/learn/advanced-use/performance) | MIT | 继续使用核心库；先改善投影、订阅、节点/边渲染，不默认更换渲染引擎 |
| [ELK.js](https://github.com/kieler/elkjs)、[许可证](https://github.com/kieler/elkjs/blob/master/LICENSE.md) | EPL-2.0 | 继续使用；布局放后台，配置与输入稳定。分发保留许可和源码获取说明，修改该组件时履行对应义务 |
| [Tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT | 继续作为语法事实来源；分别核对所用 grammar/WASM 许可证 |
| [TypeScript](https://github.com/microsoft/TypeScript)、[Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | Apache-2.0 | 已有 `createProgram/getTypeChecker`，先修复解析缺口与复用范围，不再包装一个重复引擎 |
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | MIT | 优先作为开发期 JS/TS 依赖对照，结果需人工核验，不作为调用真值；无证据不纳入运行时 |
| [Graphology Louvain](https://github.com/graphology/graphology/tree/master/src/communities-louvain) | MIT | 仅候选分组；必须超过现有规则的质量门槛，固定排序、种子与规则版本，社区编号不能作为 moduleId |
| [SCIP](https://github.com/scip-code/scip)、[scip-java](https://github.com/scip-code/scip-java) | Apache-2.0 | 试验符号索引交换；引用不是调用。索引无源码指纹/来源记录或与当前文件不一致时拒绝采用 |
| [Go tools/callgraph](https://pkg.go.dev/golang.org/x/tools/go/callgraph)、[许可证](https://github.com/golang/tools/blob/master/LICENSE) | BSD-3-Clause | 试验静态调用与动态候选分派；核对工具链、资源、离线与打包成本后决定 |

许可证判断仅覆盖上表所链接主项目，不覆盖未知插件、商业示例或全部传递依赖。T2 固定实际版本/提交，记录包体、平台、许可证及必要 NOTICE；MIT/Apache/BSD 的声明按实际条款保留。新增运行依赖只在质量增益、性能预算、维护成本、分发条件全部通过后采用；否则记录拒绝原因并改善现有适配器。候选试验不允许自动开启网络下载。

## 5. 统一输入输出约定

所有定义优先扩展 `src/types.ts` 中已有 `SemanticRelation`、`ModuleIdentity`、`ArchitectureModule`、`ArchitectureGroup`、`GraphOverviewV1` 等类型。以下是拟新增字段的语义契约，不要求机械照抄类型名或新建空壳层。

| 数据 | 必需内容与约束 |
| --- | --- |
| 关系解析依据 | 提取器名称/版本、解析方法、调用/引用位置、符号目标、确认/推断及具体原因；复用现有 confidence，禁止出现两套冲突状态 |
| 能力报告 | 语言、解析器、分析范围、可用能力、缺依赖/不支持/解析失败数量及原因；不把“无调用”与“未解析到调用”混合 |
| 模块职责依据 | 所属结构 scope、公开入口、支持归组的事实 ID、标题来源、归组规则版本；名称证据不足时明确待判定，允许人工修正 |
| 模块身份 | 持久 moduleId、锚点、成员/关系指纹、唯一前驱或显式拆并；聚类临时编号只在本次计算内部使用 |
| 展示图 | 引用真实模块 ID 的聚合节点、层级、关系类型/方向/确定性、底层事实计数、详情入口；不改变模块归属或重新评分 |
| 视图上下文 | 画布实际 CSS 宽高、可用内边距、卡片尺寸、标题实际字号、手工展开与位置、过滤条件；不进入语义指纹 |
| 展示布局响应 | generationId、userRevision、viewRequestId、投影指纹、布局规则版本、节点坐标；迟到响应拒绝应用 |

首屏概览只携带紧凑身份、层级、计数和必要关系字段；大体量证据按现有同代详情服务读取。首次生成前由界面提供视口；窗口变化只生成同代派生视图，不修改静态事实或重新分析源码。持久化的默认概览布局与当前视口布局有明确键值，不能因窗口尺寸不同伪造一个新的静态代际。

## 6. 依赖顺序与任务

主链：T0 → T10-P0 → T1a → T1b → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11。T1a/T1b 分别记录完成状态，合称 T1；各任务结束进行代码和行为审阅，本计划不要求自动委派。

T10-P0 是 T10 的窄范围数据保护前置，不代表完整 T10 提前完成：提交前重核归档清单指纹，拒绝覆盖归档后发生变化的旧数据，并覆盖预检中会绕过备份的损坏/未知输入路径。它在 T0 快照之后、其他生成路径调整之前执行；完整历史格式迁移和消费者切换仍由 T10 负责。

T1a 完成后，可以先开展 T2 的隔离工具可用性研究、T3 的确定性缺陷复现与修复、T6/T7 的投影守恒和布局夹具、T8/T9 的测量及一致性修复、T10 的历史格式盘点。这些工作不得依赖尚未完成的模块规则或协议，也不代表所属任务已退出。T2 的质量采用决定、T4 的算法调参与质量退出必须等待 T1b；T3 新增导入器必须等待 T2 的采用决定；T5 依赖 T4 的身份输入，T6/T7 的整链路验收依赖 T5。任何依赖未决时只继续独立部分，不以临时假设冒充正式契约。T11 必须等待全部任务退出及所有门槛冻结。

### T0：固定现场和保护边界

**文件：** 新建实际证据目录 `docs/evidence/static-graph-generalization/`；按匿名证据的确切文件名更新 `.gitignore` 白名单，不放开全部私密样本；读取两份设计、当前 Git 状态及现有回归测试，不改产品行为。

**交付：** `baseline-context.json`，包含工作树/分支/HEAD、已有修改文件清单及内容哈希、依赖锁指纹、工具版本、机器信息、测量规则版本，以及可恢复源码和基线可执行产物的匿名存储标识与哈希；不包含源码秘密或用户私有路径明文。

- [x] 记录 `git status --short --branch`、`git diff --stat`，对任务范围中已有修改建立可比对清单；不得 stash/reset。
- [x] 在受控位置保存可恢复的完整源码快照，或固定 HEAD 加可恢复二进制补丁、文件删除清单和全部必要未跟踪文件；保留依赖锁、构建配置及所需资源。仅记录内容哈希不足以恢复；秘密和私有数据不进入仓库证据目录，不创建 Git commit。
- [x] 检查目标目录与用户原项目不同；从封存输入恢复到独立目录，逐项核对文件清单和哈希，建立测试副本和独立 Electron userData。保留可重新运行的基线可执行产物及构建命令、环境和哈希；副本清理只作用于本任务创建的临时目录，不删除封存基线。

- [x] 运行既有迁移、详情、保存屏障、投影回归作为现场基线；记录已有失败，不把它们归因于后续改动。
- [x] 保存基线证据并核对 Git diff，确认没有改动产品源码。

验证：`npm test -- tests/main/canvas-migration.service.test.ts tests/main/canvas-detail.service.test.ts tests/main/canvas-save-coordinator.test.ts tests/renderer/graph-view-projection.test.ts`。退出：源码恢复及哈希核对成功，基线产物可在隔离环境启动，且有完整现场和可重复的隔离测试入口；通过结果只证明本次选定范围。

### T10-P0：阻止旧数据在迁移中被覆盖

**文件：** 修改 `src/main/storage/flowweave-store.ts`、必要的 `src/main/services/project-generation.service.ts` 与 `src/main/ipc/project.ipc.ts`；将 IPC 已有的纯 Canvas 形状校验抽至 `src/main/storage/canvas-shape.ts` 供存储预检复用。测试 `tests/main/flowweave-store.test.ts`、`tests/main/project-scan-static-graph.test.ts`；为保持真实提交 v7 起始状态，另更新 `tests/main/architecture-analysis.test.ts` 与 `tests/main/sequence-diagram.service.test.ts` 中的旧元数据夹具，不改测试断言。

**范围：** 这是 T10 的前置保护切片。旧数据清单的登记指纹与备份必须在最终提交边界再次核对；变化则将迁移标记为失败并停止发布，不允许覆盖或删除原输入。预检中遇到损坏、未知 Canvas/生成标记或不支持的数据形状时，先持久归档并记录错误，再阻止扫描/提交。目录初次不存在可视为无旧清单，但遍历期间任一条目消失必须作为输入变化失败，不能静默返回部分清单。

- [x] 用真实临时目录复现：请求登记并完成备份后，修改、增加或删除一个将被迁移/移除的旧文件；生成必须在提交前失败，保留变化后的原文件/新增文件，旧备份仍包含原字节，不能发布新代或删掉已变化输入。
- [x] 用损坏与未知输入回归：JSON `null`、分数版本、已知版本缺失/无效节点或边、损坏/未知 generation marker，以及无 Canvas 的未知旧产物。每种输入在任何生成写入前都有原始字节备份和失败记录，正常生成不继续。
- [x] 目录遍历从根目录不存在和子目录/文件中途消失分别测试；只对根目录最初不存在返回空清单，其他 `ENOENT` 明确失败。
- [x] 复用同一注册入口验证 open/restore/scan 的预检顺序；不得让缓存画布读取绕过迁移保护。

验证：计划测试 `npm test -- tests/main/flowweave-store.test.ts tests/main/canvas-migration.service.test.ts tests/main/project-scan-static-graph.test.ts tests/main/full-project-flow.e2e.test.ts`（4 文件、110 测试通过）；完整测试 89 文件、774 测试通过、1 项跳过；`npm run typecheck`、`npm run build` 及重建产物后的 `npm run smoke:graph` 通过。独立审查另运行存储及扫描测试 2 文件、57 测试通过，未发现阻断问题。退出：归档清单变化、损坏/未知输入和遍历竞争均不能造成写入/删除；未知真实发布格式的完整转换仍按 T10 未完成管理。

### T1：跨项目样本、真实测量和冻结验收门槛

**文件：** 修改 `scripts/run-performance-benchmarks.ts`、`scripts/run-detail-benchmarks.ts`、`scripts/run-graph-smoke.mjs`；新建 `scripts/run-static-graph-acceptance.ts`、`tests/main/static-graph-acceptance.test.ts`；生成 `docs/evidence/static-graph-generalization/corpus.json`、`acceptance-contract.json`、`baseline-run.json`、`acceptance-run.json`、`baseline.jsonl`。

**接口：** 采集与判定使用单一采样管线、两个单一职责入口：`collectStaticGraphBaseline(spec: BaselineRunSpec): Promise<BaselineRunResult>` 采集基线，`runStaticGraphAcceptance(spec: AcceptanceRunSpec): Promise<AcceptanceRunResult>` 执行冻结契约验收，均定义在新脚本。spec 显式包含 corpus 路径、可执行文件、隔离输出目录、场景及重复次数；只有验收 spec 必须包含完整冻结 contract 路径与哈希。CLI 分别使用 `baseline --spec <path>` 和 `accept --spec <path>`，不在采集函数内用模式标志切换判定规则。类型放在脚本中，不污染产品协议。

运行 spec 为每个注册项目绑定私有本地 checkout；运行前核对登记 commit、Git tree 身份、干净工作树和已冻结的样本/范围/来源元数据。常规 baseline 与 acceptance 都只运行 development；普通 acceptance 入口拒绝 holdout，留出验收只可在 T11 执行。冻结契约记录每个项目的基线 p95；性能、质量和资源 p95 逐项目判定，不跨项目平均隐藏回归。每次执行保留逐项目 JSONL 和汇总 JSON；验收结果同时记录契约路径/hash、语料 hash、目标 split 和测量身份。

基线成功表示运行记录完整且测量有效，不表示旧实现达到新目标。应用分析失败或超时必须记录阶段、错误、起止时间及无法产生后续指标的原因；不伪造“图就绪”耗时，不从分母移除。采集完整的产品失败可以形成有效基线，但必须单列失败率和不可比较项。无原因缺指标、错误代际、虚假面板就绪、遗漏运行或采集器故障，两入口均非零退出。正式验收还要求完整契约及全部门槛通过，任一产品失败或门槛失败均非零退出；结果同时区分测量有效性、产品运行结果与门槛结果。

#### T1a：测量工具与可复现开发集基线

- **已合并至 A2（R01）**：未满足；仍需修复测量链路并建立同源对照。原条款（历史口径）：如需补充测量埋点，在独立基线副本中应用仅测量用补丁，记录内容、哈希及开销检查；保留原始源码和可执行产物，确保前后对照使用相同测量口径。
- **已合并至 A1（R02）**：保留固定来源和完整源码范围；改由任务记录采集责任，取消真人签认及无关二进制资产追溯前置。原条款（历史口径）：选择至少 12 个独立真实仓库，开发集至少 8 个、最终留出集至少 4 个；每种已声明支持语言至少 2 个仓库且至少 1 个为最终留出项目。单体/多包、前端/后端/库/CLI/任务、混合语言、小中大规模组合覆盖；可重叠，但不得只用一个仓库变体填充。记录来源、固定提交、许可、范围、样本选择理由和获取负责人。当前 proposed roster 有 14 个不同 URL/commit（10 开发、4 留出），语言数量达到最低比例（TS/Python 各 2 开发+1 留出，Java/Go 各 3 开发+1 留出）；这只确认候选数量/语言覆盖。有效范围和许可仍待审核，D09/D10 尚无负责来源、范围及许可确认的真人责任人，故样本选择与冻结仍未完成。2026-10-08 D02/H03/D10 开发资产来源复核未能增加直接来源映射，详见 [`T1a development asset provenance re-audit`](evidence/static-graph-generalization/T1a-development-asset-provenance-reaudit-D02-H03-D10-2026-10-08.md)；不关闭本项。
- **已合并至 A1（R03）**：保留原 split 元数据；自动冻结身份，留出改称预留自动回归集。原条款（历史口径）：冻结开发集与最终留出集身份。T1–T10 的规则开发、工具对照和阶段回归只使用开发集及边界夹具；不查看最终留出集上的分析输出或运行结果。留出标注由独立评审者保管至 T11，实施者仅使用预先登记的样本元数据安排覆盖。
- [x] 按固定提交获取 14 个候选仓库的 codeload 源归档与浅层 detached Git checkout；逐一核对 commit、tree OID 和干净工作树，静态核对归档/路径/内容哈希、主许可证哈希和包声明文件存在性，且未执行项目内容。该证据只代表候选来源审查，不冻结最终采集范围或规模分层。
- [x] 给测量程序增加失败用例：无原因缺指标、错误代际、虚假面板就绪、遗漏失败运行必须判失败；有完整记录的基线产品失败不能误判为采集器故障，也不能使正式验收通过。未冻结 contract 允许采集基线，必须拒绝正式验收。
- [x] 建立端到端时点：目录选择结束、工作区可交互、扫描结束、语义结束、聚类结束、布局结束、提交结束、IPC 收到、图可点击、详情就绪；记录锁等待、快照校验/解析、IPC 字节、渲染长任务和整个 Electron 进程树峰值 RSS。
- **已合并至 A3（R04）**：真实 Electron 测量尚缺；保留逐项目原始结果与失败分母。原条款（历史口径）：在封存基线的测量副本上运行开发集每项目/场景至少 20 次：无应用缓存首次分析、有效缓存重开、源码增量、详情冷热、旧格式迁移。应用启动单独计时；不清 OS 缓存时明确记录，不称物理冷盘。失败样本也进入错误率和原始记录；尚缺历史夹具的场景列为未完成，不能用伪造旧格式替代。
- [x] 同时生成显式配置 `baseline-run.json` 与 `acceptance-run.json`；后者在 T1b 冻结前仅为不可用于正式验收的草案。封存可执行产物供 T11 对同一留出项目测量旧版基线，期间不得改变它的行为。2026-10-06 配置见 [`baseline-run.json`](evidence/static-graph-generalization/baseline-run.json) 与 [`acceptance-run.json`](evidence/static-graph-generalization/acceptance-run.json)：均记录 20 次重复、场景可用性、测量源码指纹和 app 哈希；增量场景与真实历史迁移夹具仍明确标为不完整。两份 spec 仅供冻结前准备，baseline 入口因 corpus=`proposed` 拒绝运行，acceptance 因 contract 尚无冻结哈希拒绝运行。spec 文件是输入配置；运行报告虽同名，但只能写入各自的隔离 `outputDirectory`，不能与证据目录中的输入配置混用。

验证：`npm test -- tests/main/static-graph-acceptance.test.ts`；基线命令为 `node --import tsx scripts/run-static-graph-acceptance.ts baseline --spec docs/evidence/static-graph-generalization/baseline-run.json`。退出：测量行为测试通过、已具备样本的开发集原始记录完整且可复现，缺少的样本/场景及获取责任明确登记；仅建立脚本不算完成。任何缺项继续阻止对应场景验收，不阻止第 6 节列明的独立工作。

当前基线状态：语料仍为 proposed，采集器拒绝对未冻结语料运行。测量管线由 `src/main/index.ts`、`src/main/services/static-graph-measurement.ts`、`scripts/run-static-graph-acceptance.ts` 记录端到端阶段、锁等待/快照、IPC、renderer long tasks 和 Electron 进程树 RSS；相关测量回归 9 项通过。T0 旧版副本在锁屏主机上被 AppKit 弹窗阻断，未启动 renderer，也未产生旧版基线报告。2026-10-06 的首轮静态来源审计核验了 9 个开发 checkout、7,841 条既有清单记录；随后按 production-oriented scope 重建 D01-D08/H03 清单，加入已获取候选 Memos 为 D10，并保留 D09。当前 proposed development scope 为 10 个样本、6,854 个源码、42,222,539 字节，规模分层为 5 小/4 中/1 大；D10 含 266 Go 与 446 TypeScript/TSX 源文件。14/10/4 选择与全部留出身份未变更；scope、来源、许可、人工标注和保管都未冻结。runner 从逐文件清单生成语言集合并执行全语料语言质量门槛，但质量证据按语言跨项目聚合，不能证明 D10 双语项目各自通过。D09 的 4,541 个 Java 文件路径、大小和哈希已核验；对已提交 Gradle 配置的静态复核确认所选 20 个模块使用 `src/main/java`，XJC 生成源仅加入 test source set，多版本目录独立，未发现会扩展所选范围的仓库内 source-set 规则。Gradle 未执行，因此动态/条件行为仍未验证；完整静态结论见 [`D09 Spring Framework review`](evidence/static-graph-generalization/D09-spring-framework-review.md)。最新 development-only 来源追溯确认 D02 的 `public/Virgil.woff2` 与固定上游 OFL 字体逐字节匹配，但其余 236 个字体仍未完成来源/许可映射；H03 固定 Guava 文件对应 9 月 22 日更新，候选 PSL 的 10,330 条规则全部出现在输出中，但输出另含 462 条，不能据此确认实际输入 revision 或 notice 处理；D10 Unicode 当前输入哈希及默认许可、锁定 BSR Google APIs 模块的 Apache-2.0 LICENSE 已核验，五张图片可追到进入仓库的历史提交及当前消费者，但原始作者/图像授权与实际发布 bundle 仍未确认。静态路径/生成头盘点见 [`T1a development license inventory follow-up`](evidence/static-graph-generalization/T1a-development-license-inventory-followup-2026-10-06.md)；补充来源追溯见 [`T1a development source and license trace follow-up`](evidence/static-graph-generalization/T1a-development-source-license-trace-2026-10-06.md)。完整来源/许可审查、责任人、基线记录与人工标签/保管仍未完成，语料和范围继续保持 proposed。

2026-10-08 对当前 development-only 语料做了只读完整性复核：10 个固定 checkout 的 commit/tree 与干净状态、6,954 条组合清单中的逐文件哈希/大小/路径、注册范围哈希及语言/字节计数均与登记一致；当前 `corpus.json` SHA-256 为 `8cdeb59d92a2326bf38c680517af481b031624869063fdfdc66afbf40ba3fcc7`。证据见 [`T1a development manifest integrity`](evidence/static-graph-generalization/T1a-development-manifest-integrity-2026-10-08.md)。这只确认当前清单完整性，不冻结样本范围或关闭来源/许可、责任人及基线测量门槛；T1a 对应项仍保持未完成。

2026-10-08 又对九个 development checkout 做了只读许可证/归属路径盘点，覆盖 [`D01/D03/D04`](evidence/static-graph-generalization/T1a-license-path-inventory-D01-D03-D04-2026-10-08.md)、[`D02/H03/D10`](evidence/static-graph-generalization/T1a-license-path-inventory-D02-H03-D10-2026-10-08.md) 与 [`D05/D07/D08`](evidence/static-graph-generalization/T1a-license-path-inventory-D05-D07-D08-2026-10-08.md)。盘点记录了固定 checkout 上的许可证/NOTICE 路径、代码头归属、生成物和依赖输入线索及哈希；发现若干明确上游代码引用、范围内未进入清单的许可证说明，以及字体、PSL、图片、Unicode 和生成代码来源映射缺口。该静态盘点未运行项目代码或安装依赖，也未检查留出内容；它没有确认许可清理、完整传递依赖清单、获取责任人或冻结范围，不构成法律许可结论，T1a 仍未完成。

2026-10-06 输出保护复核修复了采集器可覆盖旧测量目录的问题：baseline/acceptance 现在通过非递归目录创建独占领取新输出根，预先解析并检查每个计划写入目标都留在该根内，结果文件使用 `wx`；已有结果目录会在启动测量进程前被拒绝。回归验证了旧汇总和部分 run context 保持逐字节不变、无测量进程启动，以及嵌套 symlink 越界被拒绝。独立审查无阻断问题；acceptance/scenario 测试 2 文件、47 项通过，typecheck 通过。对抗性本地进程在目标预检后替换目录仍有文件系统竞态窗口；本轮不以该实现宣称已抵御此类并发篡改。

2026-10-07 埋点开销复核暂时无法形成有效 A/B：封存普通版与测量补丁版来自不同源码，且 `--flowweave-static-graph-measurement` 切换到隔离专用流程，普通版没有相同场景的等价开关；现有旧版测量报告为空。未把不同流程的差值冒充埋点开销，T1a 对应项保持未完成。

2026-10-08 在新的隔离 harness 目录重试封存测量版的合成 first-analysis smoke，以保留既有失败证据；120 秒仍未生成 protocol-7 报告，runner 退出码为 1，报告和 Electron 日志均为 0 字节。该次没有捕获窗口或证明 AppKit 弹窗再次出现，故障原因仍未知；它不构成有效 A/B 或开发集基线，T1a 两项继续未完成。命令、包/补丁哈希与隔离路径见 [`T1a baseline measurement smoke retry`](evidence/static-graph-generalization/T1a-baseline-measurement-smoke-retry-2026-10-08.json)。

补充的开发集本地路径与哈希盘点见 [`T1a-development-local-asset-provenance-2026-10-06.json`](evidence/static-graph-generalization/T1a-development-local-asset-provenance-2026-10-06.json)：D02 共 237 个 WOFF2 文件、236 种内容；H03 两份 PSL 生成文件由各自 Maven 模块纳入；D10 八个 Google API 生成 TypeScript 文件均含 Apache-2.0 头。仍无法由固定 checkout 证明字体和 PSL 的确切上游输入/许可、Unicode 输入字节与许可、Google 上游 NOTICE/完整生成链及 web 资源来源/最终嵌入；T1a 的语料来源和许可门槛未关闭。

2026-10-07 的 D02 字体哈希复核见 [`D02-font-asset-hash-audit-2026-10-07.md`](evidence/static-graph-generalization/D02-font-asset-hash-audit-2026-10-07.md) 及逐文件 [`JSONL 清单`](evidence/static-graph-generalization/D02-font-asset-sha256-2026-10-07.jsonl)：237 个跟踪 WOFF2、13,275,360 字节、236 个唯一 SHA-256；Assistant-Regular 在字体目录与 public 路径下逐字节相同。该结果只缩小本地内容映射，不证明上游输入修订或许可证；其余来源/许可及责任人仍待核实，语料继续保持 proposed。

同日记录了实施代理接触留出身份元数据的两项流程偏差，见 [`holdout-boundary process record`](evidence/static-graph-generalization/holdout-boundary-process-deviations-2026-10-07.md)。未打开留出 checkout、源码、标注、分析器输出或性能结果；后续实现继续限于开发集与合成夹具。独立验收前须由留出保管人判断是否建立新的密封留出集。

#### T1b：人工标注与门槛冻结

用户于 2026-10-06、2026-10-07 和 2026-10-08 确认暂时无法安排两名独立标注者及单独的留出保管人，并要求先完成其他工作。未使用代理标注或留出分析输出；T1b 与依赖它的 T11 继续保持未完成。

- [x] 按未落实分支登记：两名独立人工评审者、标注负责人、单独留出保管人及样本获取责任均未落实；用户于 2026-10-06、2026-10-07 和 2026-10-08 确认目前无法安排评审者和保管人。未使用代理标注或留出输出替代，缺项记录见 [`corpus.json`](evidence/static-graph-generalization/corpus.json) 与 [`development-inventory-summary.json`](evidence/static-graph-generalization/development-inventory-summary.json)。此项仅完成缺项登记，不代表 T1b 标注或留出验收完成。
- **已取消 R05**：移出本轮：两位真人、100 调用点人工配额、独立保管及主观标注研究；不声称独立真值验收。原条款（历史口径）：建立人工模块与调用标注，包含未画出的调用、歧义和不支持情况。每语言至少标注 100 个调用点，不足则全量；开发集和最终留出集分别记录分母、抽样范围和数量，最终留出集必须有独立标注。两名评审者记录模块四维评分、评分锚点及分歧处理；最终留出标签按 T1a 隔离。
- **已合并至 A1/A2（R06）**：保留可自动检查的范围、方法、指纹及预算；不保留人工评分依赖。原条款（历史口径）：补齐 T1a 未完成的开发集基线场景。按第 7 节用开发集基线冻结 contract：样本列表、支持范围、规模、质量和时间/RSS预算、测量方法、版本与哈希。最终留出集使用同一预先确定的分层规则和门槛，不根据其运行结果补定预算。
- **已取消 R07**：移出本轮：旧 formal acceptance 契约；A1 使用明确标识的自动工程配置，不伪造 reviewerIds。原条款（历史口径）：将冻结 contract 的路径和哈希写入 `acceptance-run.json`；缺预算、样本、标注或责任信息时不得宣称 T1 完成。算法调参前完成冻结，最终留出失败后不得下调门槛。

验证：重跑验收脚本行为测试，核对标注和 contract 必填项；正式验收命令为 `node --import tsx scripts/run-static-graph-acceptance.ts accept --spec docs/evidence/static-graph-generalization/acceptance-run.json`。T1b 仅在开发集执行该入口验证门槛判定，产品未达标结果作为后续任务输入；全部最终留出项目到 T11 才执行。退出：人工标注就绪、开发集原始数据齐全、contract 完整冻结；此退出不要求尚未实施的产品已通过全部发布门槛。

### T2：开源能力对照与采用决定

**文件：** 新建开发期 `scripts/compare-static-analyzers.ts`、`tests/main/static-analyzer-comparison.test.ts`；结果写入同一证据目录 `analyzer-comparison.json`。只有采用决定通过后才改 `package.json`、`package-lock.json` 和打包资源清单。

**接口：** `compareAnalyzerResults(baseline: AnalyzerEvidenceSet, candidate: AnalyzerEvidenceSet, labels: LabeledEvidenceSet): AnalyzerComparison`。三个输入使用相同文件范围与事实身份；导入依赖和调用分别计量，类型定义在脚本文件内。

- **已取消 R08**：已有四语言边界回归；本轮不采用外部候选，取消其质量优劣研究。真实仓库自动检查归 A4。原条款（历史口径）：建立真实小项目对照：TS 别名/重导出、Java 重载/接口、Go 接口分派、Python 动态属性；测试不能把引用/导入当作确认调用。
- **已取消 R09**：四候选已明确不采用且未进入生产依赖，无需继续采用前试验。原条款（历史口径）：dependency-cruiser 对照 JS/TS 导入解析；Graphology 对照模块候选；SCIP Java 和 Go tools 只在隔离研究副本运行，并记录工具链、网络、脚本执行及耗时成本。
- [x] 测试外部索引版本缺失、源码变化、目标缺失均拒绝采用；不能根据文件名相同就接受索引。索引清单绑定源码、配置、工具版本与依赖身份。
- **已取消 R10**：本轮不采用决定已有证据；取消剩余采用前评估，不把未知指标记为通过。原条款（历史口径）：逐候选记录采用/拒绝及原因：语义指标、包体/RSS/耗时、离线与 macOS arm64 可用性、维护面、许可证/NOTICE。候选错误不能被异常吞掉或当零差异。
- [x] 选择能在默认无构建流程中工作的最小组合；T2 对照不支持引入候选依赖，生产继续使用内置的无构建分析器；dependency-cruiser、Graphology、SCIP Java/Go 均未进入依赖或隐藏开关，外部索引身份防护由上项测试。候选质量与许可审查仍按未完成项处理。当前决定和依据见 [`analyzer-comparison.json`](evidence/static-graph-generalization/analyzer-comparison.json)。

验证：`npm test -- tests/main/static-analyzer-comparison.test.ts`，并运行实际工具对照、保留固定命令与原始输出。退出：每个候选都有决定；不能用“引入了库”代替质量改善证据。

当前状态：比较数据结构与拒绝错误/身份不匹配的测试已具备。合成 TS 别名/重导出及 Graphology 输入冒烟探测见 [`t2-tool-probe`](evidence/static-graph-generalization/t2-tool-probe/README.md)；其结果不是真实项目语义质量证据，也不能支持候选采用。

D01 为 root `tsconfig.json` 引用补登记了 6 个配置文件；232 个 source 行的路径、大小及哈希保持逐字节不变，配置条目由 21 增至 27。当前 manifest/scope 身份及新同范围探测见 [`T2-D01-current-scope-exploratory-2026-10-06.json`](evidence/static-graph-generalization/T2-D01-current-scope-exploratory-2026-10-06.json)。FlowWeave 分析恰好覆盖 232 个登记源文件，记录 689 条 import 事实与 527 个唯一范围内文件对；dependency-cruiser 对相同的 232 个显式源路径运行，产生 315 个范围内文件对，同时输出 12 个额外依赖模块。两者共享 315 对；这是无标签结构差异，不是精确率/召回率或质量结论。单次耗时只用于工具探测，不代表 T1 性能预算。

D02 的 FlowWeave 同范围探测见 [`T2-D02-current-scope-exploratory-2026-10-06.json`](evidence/static-graph-generalization/T2-D02-current-scope-exploratory-2026-10-06.json)：505 个登记 TypeScript/TSX 源文件中 504 个解析，1 个因 220 KB 分析上限失败；记录 3,773 条 import 事实与 2,641 个范围内文件对。随后在不改项目依赖的独立 `/tmp` 工具目录准备 dependency-cruiser 18.5.0 与 TypeScript parser 5.9.3，并在由锁定 commit 归档且逐项核验所有登记哈希的临时副本中，以 `--no-config` 仅传入相同的 505 个源码路径运行，不加载项目配置、不执行项目脚本或安装项目依赖；工具解析了全部 505 个输入，报告 1,598 个范围内 import 文件对。FlowWeave 与 dependency-cruiser 共享 1,523 对，分别仅有 1,118 对和 75 对；dependency-cruiser 还报告 417 个范围外的一跳模块及 885 条未解析依赖事实。工具原始输出摘要、命令边界和哈希见 [`T2-D02-dependency-cruiser-typescript-2026-10-06.json`](evidence/static-graph-generalization/T2-D02-dependency-cruiser-typescript-2026-10-06.json)；逐文件对差异和机械分类见 [`T2-D02-import-structure-differences-2026-10-06.json`](evidence/static-graph-generalization/T2-D02-import-structure-differences-2026-10-06.json)：532 个 FlowWeave-only 文件对对应相同但未解析的候选导入，585 对为 dependency-cruiser 未报告的 type-only 导入，另 1 对缺少相同导入事实；75 个 dependency-cruiser-only 文件对均来自超过 FlowWeave 220 KB 上限的 `App.tsx`。工具准备时曾通过 npm 网络获取临时 analyzer/parser 包，违反本节“候选试验不允许自动开启网络下载”的要求；此偏差已记录，后续候选工具试验不再自动下载。早先 TypeScript 未启用时的原始输出保留但不用于比较。配置别名和未安装包可能未解析，且没有独立人工标签；上述差异只是无标签结构比较，不是精确率/召回率、语义质量或采用证据，T2 仍未完成。

D03 的 `license-files = ["LICENSE.txt"]` 曾因解析器把所有以 `]` 结尾的行误判为表头而在第 7 行失败；已先观察到回归测试失败，再移除该误判并由 TOML 值解析器校验内容，`project-analysis-context.test.ts` 最终 7 项通过。随后独立复核又发现数组解析会静默过滤空项；现已拒绝空项、保留合法尾逗号，配置安全测试的生命周期哨兵也改为绝对临时路径。按最终 TOML 校验器重跑的当前同范围证据见 [`T2-D03-current-scope-post-toml-2026-10-06.json`](evidence/static-graph-generalization/T2-D03-current-scope-post-toml-2026-10-06.json)：24 个 Python 文件均解析且源集合与登记完全一致；dependency-cruiser 的旧同范围探测见 [`T2-D03-current-scope-exploratory-2026-10-06.json`](evidence/static-graph-generalization/T2-D03-current-scope-exploratory-2026-10-06.json)，其中 24 条导入全部报为 unresolved sentinel，不能作为 Python 导入对照工具。

SCIP-Go 仅在 D07 登记副本中完成隔离索引，可用性证据见 [`T2-scip-go-availability-2026-10-06.json`](evidence/static-graph-generalization/T2-scip-go-availability-2026-10-06.json)；38 项登记输入前后哈希一致，但 scope 仍 proposed，语义质量、完整许可证与采用均未评估。SCIP-Java 在既有隔离副本中复核：Temurin JDK `17.0.20.1+1` 可用；Seatbelt 禁网下工具 `--help`、`--version` 和 `index --help` 均退出 0，耗时分别为 0.64/0.15/0.63 秒。release 标记为 v0.13.1 的二进制自报 `0.0.0-SNAPSHOT`，且 index 帮助只说明 build configuration 和默认 build-specific 编译命令，未证明有不执行项目脚本的预生成输入模式；因此没有运行索引、Maven、Gradle或候选项目命令。证据见 [`T2-scip-java-cli-self-check-2026-10-06.json`](evidence/static-graph-generalization/T2-scip-java-cli-self-check-2026-10-06.json)，早先 Java/Seatbelt 失败记录仍保留于 [`T2-scip-java-seatbelt-minimal-lookup-2026-10-06.json`](evidence/static-graph-generalization/T2-scip-java-seatbelt-minimal-lookup-2026-10-06.json)。未访问留出项目；没有人工标签、完整传递许可证清单或可支持的候选采用/拒绝决定；候选包未加入产品依赖，T2 保持未完成。

候选当前状态与采用理由汇总见 [`analyzer-comparison.json`](evidence/static-graph-generalization/analyzer-comparison.json)。汇总已纳入 D07 隔离 SCIP-Go 索引的耗时、峰值 RSS、模块下载和 arm64 运行记录；该 proposed scope 仍无同范围语义对照或人工标签，因此不能支持质量结论或采用。

2026-10-06 重跑仓库内四语言边界回归：`npm test -- tests/main/project-language-binding.test.ts tests/main/typescript-semantic.service.test.ts tests/main/static-analysis-v5.integration.test.ts`，3 个文件、48 项通过。现有夹具覆盖 TypeScript workspace 导出/重导出、Java 重载歧义、Go 接口动态分派及 Python 动态属性/遮蔽；这是实现回归证据，不是独立真实项目候选对照或人工标注质量证据，不能关闭 T2 的比较与采用门槛。

2026-10-06 重跑 `npm test -- tests/main/static-analyzer-comparison.test.ts`，1 个文件、14 项通过。比较输入身份防护覆盖源码/配置清单哈希、精确工具与依赖版本、标签身份和超出采样范围的目标；该数据契约不代表候选已被采用或通过语义质量评估。

2026-10-08 重跑比较身份防护及 TS/Java/Go/Python 边界回归：`npm test -- --reporter=dot tests/main/static-analyzer-comparison.test.ts tests/main/project-language-binding.test.ts tests/main/typescript-semantic.service.test.ts tests/main/static-analysis-v5.integration.test.ts`，4 个文件、62 项通过。这确认现有回归仍通过，不提供 T2 所需的冻结真实范围、候选完整对照或独立人工标注质量证据；T2-180/181/183 与 T3-216 继续未完成。

### T3：统一语义证据并修复语言解析缺口

**文件：** 修改 `src/types.ts`、`src/main/services/semantic-index.service.ts`、`typescript-semantic.service.ts`、`project-language-binding.service.ts`、`language-analyzer.service.ts`；按 T2 已通过决定新增具体导入器，不先建设插件框架。测试复用 `tests/main/typescript-semantic.service.test.ts`、`semantic-index.service.test.ts`、`static-analysis-v5.integration.test.ts`。

**接口：** 保留 `analyzeTypeScriptProject`、`analyzeTreeSitterProject`、`buildSemanticIndex`；统一返回现有关系/诊断结构，并补充第 5 节解析依据和能力报告。`SemanticRelation.confidence` 仍是唯一确定性字段。

- [x] 先加入实际源码用例：TS project references/别名/重导出，Java 同名重载和缺 classpath，Go 接口与函数变量，Python 导入别名与动态调用；检查 confirmed、inferred、unresolved 分类及源码范围。
- [x] 运行目标测试确认现有缺口，然后只修复有失败证据的解析路径；复用已有 compiler checker，防止新增重复扫描。
- [x] 汇总每条关系的解析依据，确认直接调用必须有唯一目标与可定位调用点；多目标分派不能伪装成单目标确认关系。
- [x] 补齐无工具链/离线/不支持语法能力报告；错误包含阶段和原因。加载配置只做数据解析，不执行 JS 配置或生命周期脚本。
- [x] 新增解析诊断阶段进入语义索引和完整静态快照；SHA-256 与代际清单覆盖整个序列化产物，生成器版本变更使旧缓存重建，索引校验拒绝缺少阶段的错误诊断。当前采用整代重建，不做原地索引 schema 转换。
- [x] 未解析导入/调用 warning 标记为 `binding` 阶段；解析器错误仍标记为 `parsing`，持久验证保留二者语义。
- **已取消 R11**：同源码确定性语义回归已有通过证据；取消重复运行及人工标签门槛，相关代码变化才在 A4 重验。原条款（历史口径）：重跑 T2 实际对照与人工标注的语言分层质量测试。

验证：`npm test -- --reporter=dot tests/main/typescript-semantic.service.test.ts tests/main/semantic-index.service.test.ts tests/main/project-language-binding.test.ts tests/main/static-analysis-v5.integration.test.ts`（4 文件、57 测试通过）。退出：每语言支持范围与错误可解释，confirmed 不混入推断，质量按冻结门槛验收。

确定性语义证据：[`T3-semantic-regressions-2026-10-06.json`](evidence/static-graph-generalization/T3-semantic-regressions-2026-10-06.json)。持久索引拒绝不一致的 confirmed/unresolved 调用；Tree-sitter 模块身份不再被当作可调用声明；解析错误携带阶段和原因，绑定 warning 明确标为 `binding`，缺少阶段的持久错误诊断会拒绝并重建。独立审计发现 TypeScript 的 unresolved import/call、declaration-only call 与 dynamic import 警告此前漏标 `binding`；现已补齐四类标记，将语义索引生成器版本从 5.0.7 升至 5.0.8，并覆盖旧缓存失效。T3 定向组现为 59 项通过。T2 的实项目探测仍有范围/配置边界问题，且缺少独立人工标注，因此语言分层质量退出仍未完成。

### T4：功能模块与功能区识别

**文件：** 修改 `src/main/services/module-clustering.service.ts`、`static-architecture.service.ts`、`src/types.ts`；复用 `tests/main/module-clustering.service.test.ts`、`static-architecture.service.test.ts`。

**接口：** 将 `clusterArchitectureModules(files, relations, previousModules, scopes)` 的 scope 输入明确化，调用点统一传入；扩展现有结果的职责依据/诊断。新增 `deriveArchitectureGroups(modules: readonly ArchitectureModule[], facts: ProjectStructureFacts): ArchitectureGroup[]`，定义在 `static-architecture.service.ts`，替代以通用目录直接退回根包的分组决定。

- [x] 加入无功能目录、同名不同包、共享日志/数据库、功能跨 API/服务/存储、稀疏无调用项目的夹具，断言归属合理、不可跨硬边界误并、弱证据明确待判定。
- [x] 按 scope 建候选；公开入口与已确认关系优先，路径与命名作为辅助。公共支撑根据跨职责使用和代码证据识别，不能只按高入度判公共模块。
- [x] T2 未采纳 Graphology，因此保留经边界夹具改进的确定性现有规则，不增加第二套生产策略；其实现和测试见本任务第 2、3 项。职责质量仍需人工开发集标签评审，见本任务末项。
- [x] 将目录、导出符号、文件名、模块类别及包 scope 的标题来源写入 ArchitectureGroup，并随功能区引用持久化；名称来源回归覆盖目录、符号和类别。唯一文件归属沿用现有方案，显式报告单文件混合职责，不预先引入符号级多归属。
- **已取消 R12**：尚无触发该扩展的可复现证据；取消预建方案，保留单文件混合职责诊断。原条款（历史口径）：若开发集或 T11 证明文件级归属无法满足冻结质量门槛，T4 保持或恢复为未完成，禁止缩小支持声明或降低门槛；先补充符号级唯一归属的实施设计，明确事实计数、模块身份、schema 转换、用户修正和引用迁移，并将其纳入 T3–T5 及 T10 的重验范围后再实施。该条件触发时，旧深化设计中的符号级要求仍为未决项，不能以文件级实现完成替代。
- [x] 用稳定的功能区身份贯通 `areaId`、`groupPath`、筛选和折叠；包 scope 只作层级边界，不能单独冒充具有单一职责的功能区。定向验证 `npm test -- --reporter=dot tests/main/module-clustering.service.test.ts tests/main/static-architecture.service.test.ts tests/renderer/canvas-filters.test.ts tests/renderer/canvas-hierarchy.test.ts tests/renderer/graph-view-projection.test.ts`：5 个文件、76 项通过。
- **已取消 R13**：人工主观评分移出本轮；scope、唯一归属、稳定身份及待判定的既有自动回归保留。原条款（历史口径）：用开发集人工标注评审过度合并、碎片化和待判定占比；阶段回归仅使用开发集及边界夹具，最终留出集统一在 T11 运行。标签/评审人未落实前不作职责质量结论。

验证：`npm test -- tests/main/module-clustering.service.test.ts tests/main/static-architecture.service.test.ts`。退出：开发集四维模块评审逐项目达标，最终留出质量仍待 T11 验收；142/74 等历史数量仅是缺陷线索，不作为期望模块数量。

确定性来源证据：[`T4-architecture-name-sources-2026-10-06.json`](evidence/static-graph-generalization/T4-architecture-name-sources-2026-10-06.json)。areaId/groupPath 的身份贯通及筛选/折叠回归在 5 个测试文件、76 项中通过；真实开发集模块质量评审及候选工具的质量/许可审查仍未完成。

### T5：稳定身份、用户修正与拆并迁移

**文件：** 修改 `src/main/services/module-clustering.service.ts`、`canvas-migration.service.ts`、`src/main/storage/flowweave-store.ts`、`src/utils/module-assessment.ts`；测试 `tests/main/canvas-migration.service.test.ts`、`module-assessment.test.ts`。

**接口：** 复用 `ModuleIdentity` 和 `reconcileGeneratedCanvas`，在现有前驱信息中显式表达唯一延续/拆分/合并，不以候选聚类序号生成持久身份；继续使用现有用户 revision。

- [x] 固定失败场景：同职责增减文件、入口文件新增、重命名、跨目录移动、同 ID 新职责、拆分合并、两项竞争同一前驱。
- [x] 唯一且证据充分时保留身份和用户修正；重命名/移动证据不足时进入待处理，不能用单个重叠文件强行继承。
- [x] 文件归属修正按新基线重放；冲突保留原始修正和原因。隐藏意图核对事实身份，聚合视图变化不得改变真实隐藏状态。
- [x] 校验评估依据覆盖合并修正后的实际输入；布局/备注不失效，文件/职责/关系变动会失效，人工风险覆盖独立保留。
- [x] 连续执行三次重扫与两次保存/重开，确认待处理幂等、用户状态不被轻量保存清空。

确定性回归证据：[`T5-migration-regressions-2026-10-06.json`](evidence/static-graph-generalization/T5-migration-regressions-2026-10-06.json)。合成夹具不能替代 T10 的真实待处理数据导出、恢复和用户判断，因此 T5 整体退出仍受该项约束。

验证：`npm test -- tests/main/canvas-migration.service.test.ts tests/main/module-assessment.test.ts`。退出：无误迁移、无静默丢失，所有未决数据可导出恢复。

### T6：按视口生成展示层级

**文件：** 修改 `src/utils/graph-view-projection.ts`、`src/main/services/static-graph-layout.service.ts`、`src/components/CanvasWorkspace.tsx`、`src/types.ts`、IPC/preload；测试 `tests/renderer/graph-view-projection.test.ts`、`tests/main/static-graph-layout.service.test.ts`。

**接口：** 在 `graph-view-projection.ts` 定义 `selectOverviewFrontier(input: OverviewFrontierInput): OverviewFrontierResult`。输入为当前同代模块/功能区、视口、过滤、展开偏好与卡片尺寸；返回展示节点 ID、聚合映射、待展开计数及可读性诊断。基于现有 `ProjectedGraph` 生成结果，不再定义第二种图实体。

- [x] 先覆盖 BrowserWindow 为 960×640、1440×900、1920×1080 的测试窗口，逐项记录实际可用 `.canvas-flow-stage` 尺寸、侧栏状态、可见节点及重叠；不能将整窗尺寸直接当作画布等值目标。另测详情面板开启状态、窄窗控件可达性，以及按 React Flow 缩放折算后的卡片标题/正文实际字号；固定节点数量折叠应无法满足这些用例。
- [x] 按面积和卡片最小可读尺寸选择一组不重复覆盖的层级节点，取代 `INITIAL_NODE_BUDGET` 作为首图决策。手工展开状态优先，不因 resize 自动收起用户正在看的模块。
- [x] 聚合按端点、方向、类型、确定性分别计数；底层关系恰好被归入展示边、组内计数或明确过滤原因，不能悄悄消失。
- [x] 当完整范围无法保持最小字号时进入可导航总览/局部视图，提供面包屑、模块数及返回入口；无证据支持的集合使用“结构范围/待细分”等明确标签。
- [x] 请求响应绑定 generationId、userRevision、viewRequestId；窗口缩放只触发同代展示计算，过期投影不能回写状态。

验证：`npm test -- tests/renderer/graph-view-projection.test.ts tests/main/static-graph-layout.service.test.ts`；`FLOWWEAVE_GRAPH_SMOKE_FIXTURE=viewport-only npm run smoke:graph`，记录三档 BrowserWindow 尺寸与对应实际 canvas stage、详情面板、控件命中、节点重叠和缩放后标题/正文字号。退出：首图语义可达、数据守恒、不改事实身份，三档窗口均能浏览。

打包版三档视口证据复用 [`T7-port-fix-packaged-viewport-2026-10-06.json`](evidence/static-graph-generalization/T7-port-fix-packaged-viewport-2026-10-06.json)：960×640、1440×900、1920×1080 均记录实际 stage、详情面板、六项控件可达、零节点重叠及缩放后字号；窄档以可读性提示说明空间不足。定向 2 个测试文件 / 30 项通过。

### T7：稳定布局与精简交互

**文件：** 修改 `static-graph-layout.service.ts`、`src/utils/canvas-layout.ts`、`CanvasWorkspace.tsx`、`src/stores/canvas.store.ts`、`src/styles.css`、`src/utils/i18n.ts`；测试 `tests/renderer/canvas-layout.test.ts`、`canvas-toolbar-controls.test.ts`、`canvas-filters.test.ts`、`workspace-layout.test.ts`，扩展图形冒烟。

**接口：** 布局继续使用现有服务，输入为 T6 展示图和明确的布局上下文；缓存键包含代际、投影拓扑、尺寸、规则版本及手工位置修订。语义输入指纹不包含缩放、备注和窗口尺寸。

- [x] 加入链式、星形、密集、循环、断连、超长标题的实际布局断言；覆盖同输入重复运行、组展开/收起和固定位置。
- [x] 使用分层布局和稳定节点排序；弱连通执行区域分别布局后按 ID 稳定打包；循环组仅用于视图表达，真实方向关系不变。
- [x] 静态/视图布局共用保守节点尺寸，React Flow 节点和折叠组句柄共用尺寸常量；实际节点尺寸变化时使用 React Flow 实测值并使布局缓存失效。
- [x] 将动态边端口位置纳入 ELK 布局约束；静态布局使用 ELK 端口约束，renderer 自动/刷新布局在最终节点坐标上按当前可见拓扑重算约束句柄。
- [x] 后台只布局展开后新增节点，以旧分组为锚点在四圈邻域寻找位置；既有可见节点和人工位置作为障碍保持不动。邻域无空间时保留原坐标并提供全图“自动布局”动作；折叠只更新组卡位置。
- [x] 常驻搜索、整理布局、筛选；筛选内分别放功能区、技术角色、技术栈和关系。必要的浏览层级入口保留，组内并集/组间交集/重置语义统一；迁移旧偏好，不创建同义选项。
- [x] 搜索结果导航在目标可见且布局稳定后交接键盘焦点；活动筛选显示匹配/总模块数，零结果保留状态提示和重置入口。
- [x] 可读性告警提供现有全图整理动作，供空间不足时显式重新整理。
- [x] 在隔离 DEV renderer 上采集初始、展开、收起、技术筛选和自动布局的 React Profiler 样本，保留每个提交及动作耗时；另采集三次组件级样本评估模块/分组节点、边和详情面板耗时。
- [x] 基于同一源码指纹、DEV 构建与七项动作，对 CanvasWorkspace root 和节点/边/面板组件同步采样三次；没有稳定主导的 renderer 组件热点，故不收窄 Zustand 订阅或稳定节点/边引用。汇总见 [`T7 matched DEV profiler decision`](evidence/static-graph-generalization/T7-react-profiler-matched-layout-state-dev-summary-2026-10-08.json)。该决定只代表 synthetic `viewport-only` 热点探查，不构成 T1 性能验收或 before/after 改善；面板 profiler 是 App.tsx 中独立的兄弟边界。
- 三次组件级原始报告、哈希、复现方式与中位数见 [`T7 component Profiler summary`](evidence/static-graph-generalization/T7-react-profiler-component-dev-summary-2026-10-06.md)；该结果仅用于热点探查，不替代可比较基线。
- [x] 打包版 Tab 顺序已通过原生完整焦点循环；其路径见 [`T11-current-packaged-arm64-2026-10-08-native-keyboard-manual.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-native-keyboard-manual.json)。
- **已取消 R14**：现有三档字号、零重叠、控件可达及原生键盘证据覆盖机器指标；取消重复采集和真人主观门槛。原条款（历史口径）：真人视觉验收仍缺：最新包三档视口测量无节点重叠，960×640 仍提示可读性空间不足；截图索引见 [`T11-current-packaged-arm64-2026-10-08-summary.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-summary.json)。仍需真人判断窄窗可读性。

验证：运行上述四个 renderer 文件及 `npm run smoke:graph`。退出：第 7 节布局门槛通过；仅 DOM 存在或边数量大于零不算视觉验收。

布局与交互回归证据：[`T7-layout-interaction-regressions-2026-10-06.json`](evidence/static-graph-generalization/T7-layout-interaction-regressions-2026-10-06.json)。静态与 renderer 共用 ELK 端口辅助逻辑；renderer 自动布局、刷新和局部展开/收起均按最终可见节点与边生成句柄。缓存校验节点尺寸、坐标和边 ID/方向/关系；旧缓存或新增手动边使指纹失效并触发重算，拓扑指纹能经协议保存和重开保留。定向复核通过 6 个测试文件 / 88 项，并用真实 ELK 探针核对手动并行边、折叠组和展开布局。新 arm64 包启动 smoke 与 `edges` 图形 smoke 通过；三档 viewport 均无重叠且六项控件可达，原始报告为 [`T7-port-fix-packaged-edges-2026-10-06.json`](evidence/static-graph-generalization/T7-port-fix-packaged-edges-2026-10-06.json) 和 [`T7-port-fix-packaged-viewport-2026-10-06.json`](evidence/static-graph-generalization/T7-port-fix-packaged-viewport-2026-10-06.json)。局部布局请求绑定项目、代际和视图模式，避免切换时误用旧展开请求。分组 Expand 按钮显式处理 Enter/Space；同一最新包的四语言 smoke 已抵达键盘验证，但输入前窗口未取得系统焦点（`windowFocused=false`、`documentHasFocus=false`），记录于 [`T7-port-fix-packaged-four-languages-2026-10-06.json`](evidence/static-graph-generalization/T7-port-fix-packaged-four-languages-2026-10-06.json)。

2026-10-06 的 smoke-only trace 报告为 [`T7-react-profiler-strictmode-fix-2026-10-06.json`](evidence/static-graph-generalization/T7-react-profiler-strictmode-fix-2026-10-06.json) 和 [`T7-react-profiler-layout-state-dev-2026-10-06.json`](evidence/static-graph-generalization/T7-react-profiler-layout-state-dev-2026-10-06.json)。首轮 DEV renderer trace 证明 `flushCurrentCanvas` 已完成，随后 `React.StrictMode` 的 effect 重放使请求 guard 失效，而 `requestedRestoreProjectId` 去重又阻止第二次恢复；现已在恢复 effect cleanup 清除该项目去重标记，并通过 action ref 保持 effect 依赖稳定。修复后的 trace 显示恢复读、generation 注册、cache 读取、worker 启动与结果、提交、终态发送/接收、renderer apply 均完成；成功的 DEV layout-state smoke 记录 149 个 `CanvasWorkspace` Profiler 提交：初始 86/60.1 ms、展开 15/33.6 ms、收起 28/18.4 ms、技术筛选 4/6.1 ms、自动布局刷新 16/22.6 ms。该 profile 仅为单次开发夹具，技术筛选后的视图为零节点，不能作为冻结性能验收或子组件热点判断；普通 React-profile smoke 随后因找不到启用的全图布局控件而失败，原报告保留于同目录。此前打包版四语言 smoke 的窗口焦点仍未取得；Tab 顺序和人工视觉复核继续未完成。

### T8：快速进入与增量更新

**文件：** 修改 `src/main/ipc/project.ipc.ts`、`project-generation.service.ts`、`semantic-index.service.ts`、`source-snapshot.service.ts`、`project-scan-fingerprint.service.ts`、`src/hooks/useProjectActions.ts`；测试 `tests/main/project-scan-static-graph.test.ts`、`generation-transaction.test.ts`、`semantic-index.service.test.ts`。

**接口：** 沿用当前项目登记、后台进度、已提交图读取接口；阶段计时使用 T1 的同一事件格式。缓存身份包含内容/配置/依赖身份/分析器版本，不以请求 ID 或文件时间戳单独代表内容有效。

- [x] 增加打开立即切换、重复请求、源码在扫描期间改变、mtime 不变但内容变化、配置/依赖改变、文件删除和分析中取消的集成用例。
- [x] 将工作区可交互之前的非必要分析移至后台；先显示真实阶段和错误信息，不生成假进度百分比。
- [x] 仅复用经过完整有效性检查的事实；根据符号/配置依赖扩大受影响范围。无法证明局部有效时明确执行完整重新分析，不静默使用旧结果。
- [x] 布局缓存独立于语义；有效缓存图可作为标明时间与待核验状态的只读预览，核验成功后才能成为当前可编辑图。
- **已合并至 A3（R15）**：与 T1a 同一测量管线合并，不能用合成 smoke 代替。原条款（历史口径）：在打包版执行 T1 的冷开、热开、增量矩阵，定位任何超预算阶段并修复；不以隐藏图、截断范围或减小支持范围换达标。

验证：运行上述三个 main 测试及 T1 验收脚本。退出：工作区目标及冻结分层预算通过，错误/取消不遗留正在编辑的过期图。

代码与回归证据：[`T8-cache-preview-regressions-2026-10-06.json`](evidence/static-graph-generalization/T8-cache-preview-regressions-2026-10-06.json)。打包版分层性能矩阵仍依赖 T1 冻结样本和预算。

### T9：详情链路、保存屏障和有限内存

**文件：** 修改 `canvas-detail.service.ts`、`src/hooks/canvas-save-coordinator.ts`、`useCanvasPersistence.ts`、`src/components/ModulePanel.tsx`、`ConnectionPanel.tsx`；测试 `tests/main/canvas-detail.service.test.ts`、`canvas-save-coordinator.test.ts`、`tests/renderer/canvas-diagnostics.test.ts` 和图形冒烟。

**接口：** 保持现有 generationId/userRevision/targetId 请求响应契约；相关未保存修正先经屏障，详情面板只应用当前选中目标的有效响应。缓存有明确字节预算和逐出规则，测实际进程内存而不只计算序列化字节。

- [x] 复用已有延迟提交测试，新增分析期间关闭/切换、连续选中 A/B、保存后 revision 改变、快照损坏、缓存逐出及多项目切换；T8 请求竞争测试与打包版 details-race 覆盖切换。
- [x] 分开记录锁等待、文件读/校验、解析/索引、IPC、面板呈现耗时；IPC 与面板提交按项目、generation、revision、node 关联，作为 optional 指标，不替代详情点击总延迟。
- [x] 同代并发首次请求共享校验解析，热点击不重复整份解析；每次读取当前用户修正，文件移动后诊断随归属更新。
- [x] 验证保存失败保留编辑并阻止依赖操作，晚到详情不会覆盖新选择；错误保留具体类型，不显示旧成功内容掩盖损坏。
- [x] 服务级合成快照基准覆盖 small/medium/large、legacy/indexed、cold/warm，每格 20 次；结果显示 indexed warm 读取收益，但 cold 解析成本更高，不据此改变策略。证据：[`detail-benchmark-2026-10-06.json`](evidence/static-graph-generalization/detail-benchmark-2026-10-06.json)。
- **已合并至 A3（R16）**：与 T1a/T8 合并；保留真实面板总延迟及完整进程树峰值 RSS。原条款（历史口径）：Electron 真实项目的详情冷热 IPC/面板矩阵仍需逐项目至少 20 次；T1 样本与基线未冻结前不生成正式性能结论。只有证据显示快照读取仍是超预算主因才另行设计原子详情分片，本轮不预置第二套详情产物。

验证：运行上述三个测试文件、`npm run smoke:graph` 和 `npm run benchmark:detail -- docs/evidence/static-graph-generalization/detail-benchmark-2026-10-06.json`；服务基准须与 Electron 详情矩阵一起通过。退出：新鲜度与内存上限成立，分层端到端预算达标。

### T10：历史数据收尾与所有消费者切换

**文件：** 修改 `canvas-migration.service.ts`、`src/main/storage/flowweave-store.ts`、画布现有迁移审阅入口；审计 `project-analysis-context.service.ts`、`architecture-review.service.ts`、`sequence-diagram.service.ts`、`sequence-review.service.ts`、`src/utils/export-artifacts.ts` 及任务/Agent 入口。测试复用 `canvas-migration.service.test.ts`、`flowweave-store.test.ts`、`full-project-flow.e2e.test.ts`。

**接口：** 保留原始待处理 payload；人工操作定义为重新绑定、继续保留、明确放弃，均带目标代际和用户 revision，并写入现有用户状态。不自动删除历史备份。

- **已取消 R17**：公开来源调查已完成；穷尽私发/未知历史格式的保证移出本轮。已支持格式守恒和未知格式保全仍属 A4。原条款（历史口径）：盘点真实发布格式及各消费者的用户字段/引用；每个已发布变体有可恢复夹具，未知格式保全并阻止覆盖，不能以 v1–v6 枚举代替实际格式调查。
- [x] 展示孤立节点/关系的旧内容、候选目标与证据，提供重新绑定/保留/放弃和导出；端点无法唯一映射的关系留待处理。
- **已取消 R18**：取消需要用户参与的数据处置；歧义项自动保留原内容、引用和导出能力，不自动重绑、放弃或删除。原条款（历史口径）：在隔离副本处理真实待审项；需要用户判断的职责对应不能由代理猜测。未获得判断时保留并明确迁移验收未完成，其余独立工作继续。
- [x] 打通正常任务、上下文、审查、序列与导出运行测试，记录实际读取来源，确认只消费已提交新协议，不直接触发完整生成或拼读混代文件。
- [x] 进行中断写入/恢复、幂等重跑、备份恢复演练；验证不可重建字段和引用完整后移除对应旧运行分支。旧格式解码器仅保留在迁移边界，UI 形状若仍有适配需证明其为单一新模型的纯投影。

验证：运行上述三个测试文件及消费者实际流程。退出：发布格式盘点齐全、字段守恒、无旧运行路径；保留待处理不等于完成用户数据处置。

本轮消费者与迁移回归证据：[`T10-consumer-matrix.md`](evidence/static-graph-generalization/T10-consumer-matrix.md)、[`T10-integration-2026-10-06.json`](evidence/static-graph-generalization/T10-integration-2026-10-06.json) 和 [`T10 review-sidecar migration`](evidence/static-graph-generalization/T10-review-sidecar-migration-2026-10-06.json)。新增临时目录迁移回归验证 `architecture-review.json`、`sequence-review.json` 在新代生成前后及归档中保持逐字节一致，两个读取器将旧代状态返回为 `stale`。另补 v1–v6 六种 Canvas 与未识别 protocol-v7 图侧车并存的 TDD 回归：六例先复现预检错误放行，加入共享入口守卫后均拒绝生成，原文件和备份保持逐字节一致，且未登记 generation request；用例位于 `tests/main/flowweave-store.test.ts`。五个存储/迁移测试文件 172 项通过；本轮最终全套验证 `npm test -- --reporter=dot` 为 103 文件、957 项通过、1 项跳过，`npm run typecheck`、`npm run build`、`git diff --check` 均退出 0。只读核对发现仓库当前无 Git 标签，公开 [GitHub Releases](https://github.com/Caesarqing/FlowWeave/releases) 也无发行包；这不能排除私下或旁路分发，也不能证明真实项目中的历史格式清单。合成恢复/迁移用例通过；权威分发清单、真实历史格式夹具、真实孤立项处置及人工判断仍未完成，计划维持实施中。

2026-10-07 最终格式复核发现预检此前仍接受已知 envelope 内的未声明字段。现在 Project、ArchitectureMap 及其递归用户数据对象均拒绝未知键，同时保留 `summary.languages` 动态语言名与 v1/v2/v3 版本边界；回归覆盖项目根/文件树/`git`、架构根/模块/证据/assessment factor。定向 `tests/main/flowweave-store.test.ts` 72 项通过；最新全套 `npm test` 为 103 文件、981 项通过、1 项跳过，`npm run build`（包含两项 typecheck）成功。这加强了代码可知格式的保护，但仍不代替权威发布格式清单、真实历史夹具和真实用户处置。

2026-10-07 T10 数据保护复核发现旧 Canvas 旁的 `project.json`、`architecture-local.json`、`architecture-map.json` 也会在迁移时删除或替换。共享预检现在仅接受源码可证明的历史 envelope（Project v1/v2、ArchitectureMap v1/v2/v3；local 文件必须为 `source: local`），并递归校验项目树及架构模块、关系、文件、符号的必需字段与已知可选字段；v1/v2 不接受 v3 专属字段；源码位置要求正整数。未知版本/形状、错误来源、畸形嵌套项和损坏 JSON 会先按原字节归档、写失败记录，再拒绝登记 generation request。回归覆盖错误树/数组项、v2 携带 v3 字段、非法 assessment、`scanDelta.added` 与位置坐标；红灯先复现 10 个格式放行。有效 v2 assessment 与 v3 groups 夹具仍可迁移。格式预检明确不拦截 `.flowweave/index/manifest.json` 与 `semantic-index.json`：可重建缓存仍会进入迁移原字节备份（回归断言两者备份字节一致）；可解析但版本、形状或身份不匹配的缓存会重建，无法解析的缓存仍报错并保留。定向存储/迁移测试 2 文件、96 项通过；本轮全套验证 `npm test -- --reporter=dot` 为 103 文件、972 项通过、1 项跳过，`npm run typecheck` 与 `npm run build` 退出 0。该修复不替代真实发布格式清单和真实备份审计。

2026-10-07 对 worktree 的 `release/mac-arm64/FlowWeave.app` 做只读盘点：文件系统时间为 2026-10-04，内嵌版本 0.1.0、arm64、ad-hoc 签名；`app.asar` SHA-256 为 `7edc029266c72a42de3a48445b01f9f56b914a777058a68f81c1dc172966c865`。内嵌主进程出现三处 `storageProtocol: 7` 标记。该路径被 `.gitignore` 排除，未建立对应源码提交或分发记录；因此它只能证明本地存在一个 protocol-v7 构建，不能证明已发布 v1–v6 格式或真实用户数据。盘点及限制见 [`T10-local-bundle-provenance-2026-10-07.json`](evidence/static-graph-generalization/T10-local-bundle-provenance-2026-10-07.json)；T10 的发布来源与真实迁移夹具仍未完成。

2026-10-08 再核对公开来源：`git ls-remote --tags origin` 退出 0 且无 tag refs，GitHub releases API 返回空数组；[GitHub Releases](https://github.com/Caesarqing/FlowWeave/releases) 页面也未列出公开 release。该结果只排除本 origin 的公开 tag/release，不排除私有或旁路分发；命令结果和来源 URL 记录在 [`T10-local-bundle-provenance-2026-10-07.json`](evidence/static-graph-generalization/T10-local-bundle-provenance-2026-10-07.json)。

2026-10-08 补查 `.github/workflows/windows-build.yml`：`main` push 或手动触发的 Desktop packages 工作流会上传 macOS/Windows 构建包，保留 1 天，构建命令使用 `--publish never`。公开 Actions API 当前列出 4 次运行（最近一次 2026-09-23）：7 月 15 日运行的 macOS ARM64、Windows x64、原生 Windows ARM64 构建及打包 smoke、artifact upload 步骤成功，交叉构建 fallback 跳过，但当前 artifacts 已不可列出；之后 3 次运行的全部构建 job 均失败。四次运行的 artifacts 列表都为空，因此目前无法从这些公开运行取回安装包。短保留期不能证明历史产物从未下载或经其他渠道分享；该工作流、运行 ID、逐 job 结果、API 地址和边界记录见 [`T10-local-bundle-provenance-2026-10-07.json`](evidence/static-graph-generalization/T10-local-bundle-provenance-2026-10-07.json)。真实分发来源和真实用户格式仍待确认。

### T11：留出验收、打包与发布退出

**文件：** 仅修复验收实际失败涉及的文件；在本文件更新任务勾选和证据链接。两份旧文档保持为历史参考，不续写新的任务状态。

- **已合并至 A4/A6（R19）**：改为预留仓库的自动兼容性/稳定性回归，保留首轮报告；不宣称人工真值或独立泛化证明。原条款（历史口径）：确认 T1b 完成及其他任务退出，冻结待验代码/规则/依赖指纹，首次运行全部最终留出项目并解封独立标注；用 T0/T1a 封存基线和待验产物按相同口径交错采集，首次完整报告在任何修复前封存。
- **已取消 R20**：取消未触发的单独研究任务；失败保留、修复重验与禁止放宽门槛归 A4/A6。原条款（历史口径）：留出失败后，记录失败样本、原因、修复依据及受影响任务；需要修改时返回对应任务实施并重验。原留出样本全部保留，其后结果明确标为“留出失败后的修复回归”，不得再声称首次独立验证；禁止下调门槛或替换失败样本。若要证明修复后的独立泛化，另增未参与开发且覆盖受影响类别的独立项目和人工标注，预先登记后沿用冻结门槛验收；新项目不能替代原失败样本的回归，未取得独立验证则保持该项未完成。
- [x] 运行 `npm run typecheck`、`npm test -- --reporter=dot`、`npm run build`、`git diff --check`，记录命令、环境、退出码、跳过原因。2026-10-08 当前工作树全套测试为 103 个文件、981 项通过、1 项跳过；typecheck、临时目录生产构建、bundle-size 检查及最终 `git diff --check` 均退出 0，构建含 1,958 个 renderer modules。精确结果与范围见 [`T11-current-packaged-arm64-2026-10-08-summary.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-summary.json)。
- [x] arm64 目录包的 `smoke:packaged` 与 graph smoke 已运行。StrictMode 修复后、TOML 校验后两组包分别通过 edges、empty、save-failure、tab-switch、viewport-only、details-race；报告见 [`T11-post-strictmode`](evidence/static-graph-generalization/T11-post-strictmode-packaged-edges-2026-10-06.json)、[`T11-post-toml`](evidence/static-graph-generalization/T11-post-toml-package-2026-10-06.json)。2026-10-07 一份 arm64 包的七个 fixture 均有完成报告（edges、empty、four-languages、save-failure、tab-switch、viewport-only、details-race），`app.asar` SHA-256 为 `778b3ae8a2c7726954d9c724be6ede456944907385c5d8b8a46e8413e022a006`；详情见 [`T11-current-packaged-artifact-2026-10-07.json`](evidence/static-graph-generalization/T11-current-packaged-artifact-2026-10-07.json)。`empty` 首次单独运行失败、紧接复跑通过，根因未确定；两份报告都保留。之后以新建、SHA-256 为 `757133fa0cb68c9c159b901cc204d6f75f9e191455dd5089e9aeb9aaa24e4152` 的精确 arm64 包重跑 `smoke:packaged` 与全部六个非键盘 graph fixture，均通过；结果、包哈希和截图见 [`T11-current-packaged-visual-artifact-2026-10-07.json`](evidence/static-graph-generalization/T11-current-packaged-visual-artifact-2026-10-07.json)。2026-10-08 再以临时目录重建的 arm64 包运行 `smoke:packaged` 及七个隔离合成 fixture，均通过；`app.asar`/可执行文件 SHA-256、包路径和逐项报告索引见 [`T11-current-packaged-arm64-2026-10-08-summary.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-summary.json)。这些自动化结果不替代原生键盘输入、人工视觉检查或 T1 冻结门槛。
- [x] 四语言键盘导航的原生键盘验收已在同一 arm64 包上通过：完整 Tab 循环可达三模块未关联组，原生 Return 展开该组，原生 Escape 返回总览并恢复焦点；交互与包哈希见 [`T11-current-packaged-arm64-2026-10-08-native-keyboard-manual.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-native-keyboard-manual.json)。三次 native-smoke harness 报告均未观察到测试窗口的按键事件，失败报告仍保留；随后直接通过桌面原生输入完成验收。此前 Electron `webContents.sendInputEvent` 报告见 [`T11-current-packaged-arm64-2026-10-08-four-languages.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-four-languages.json)，不单独作为原生键盘证据。
- **已合并至 A6（R21）**：同一最终包运行自动工程验收；人工主观判断移出，原始截图和机器指标保留。原条款（历史口径）：对同一打包产物运行 T1 完整验收；人工查看三档窗口、展开/返回、关系证据、分析状态和迁移审阅，存截图与结果。2026-10-08 最新包三档视口截图见总报告 [`T11-current-packaged-arm64-2026-10-08-summary.json`](evidence/static-graph-generalization/T11-current-packaged-arm64-2026-10-08-summary.json)；自动测量显示三档均无节点重叠、必要控件可达，960×640 仍有空间不足/可读性提示。截图与自动测量不能替代真人对窄窗可读性及展开/返回、关系证据、分析状态和迁移审阅的判断。
- [x] 核对打包资源和许可证：最新 post-TOML arm64 app.asar 含 66 个 canonical 包根目录，均有许可证元数据和随包许可证文件；20 个 Contents/Resources 文件均有哈希。当前包报告为 [`T11-post-toml-package-audit-2026-10-06.json`](evidence/static-graph-generalization/T11-post-toml-package-audit-2026-10-06.json)；较早的 StrictMode 包审计保留于 [`T11-post-strictmode-package-audit-2026-10-06.json`](evidence/static-graph-generalization/T11-post-strictmode-package-audit-2026-10-06.json)，既有完整包审计见 [`T11-package-audit-final-2026-10-06.json`](evidence/static-graph-generalization/T11-package-audit-final-2026-10-06.json)。
- **已取消 R22**：正式对外发行移出本轮，交付本地测试包；现有 ad-hoc 验签失败仍须在 A5 修复。原条款（历史口径）：正式 macOS 发布仍需 Developer ID 签名、公证和安装验证；T7 与最新 post-TOML arm64 测试包均为 ad-hoc 签名、TeamIdentifier 未设置，`codesign --verify --deep --strict` 报告 `code has no resources but signature indicates they must be present`。重新核验的 `security find-identity -p codesigning -v` 显示 0 个有效签名身份；`notarytool history` 明确要求未提供的认证信息，故不能完成正式签名/公证。
- [x] 对照第 8 节完成要求映射，并核验旧深化设计关键要求与本轮证据的覆盖情况；未满足门槛均保留为未决。映射见 [`T11-requirements-mapping-2026-10-06.md`](evidence/static-graph-generalization/T11-requirements-mapping-2026-10-06.md)。
- **已合并至 A6（R23）**：只在 A1–A6 通过后关闭自动工程实施，不宣称被取消的研究或发行目标完成。原条款（历史口径）：所有任务退出条件和发布门槛通过后，才将本计划状态改为完成；届时输出改动、通过证据、未决事项和复现方式，保持所有修改未提交。

退出：功能、语义、性能、迁移、可读性和发布范围全部有证据。无法取得历史样本、人工标注或签名材料属于明确未决条件，不能以全部自动测试通过替代。

## 7. 冻结的验收方法与门槛

### 7.1 分层与性能

T1a 先采集开发集基线，T1b 在任何算法调参前冻结 `acceptance-contract.json`。基线采集和正式验收的成功条件以第 6 节 T1 的接口契约为准。初始规模按纳入分析的有效源码文件数划分：小 ≤200，中 201–2000，大 >2000；同时记录源码字节、符号/调用数量、语言和拓扑密度。文件数不能覆盖复杂度差异，同规模仍逐项目及语言报告，不跨类别平均掩盖失败。若基线证实分层失真，只允许在冻结前记录理由重新分层。

| 指标 | 执行要求 |
| --- | --- |
| 进入工作区 | 应用已运行时，目录选择完成至工作区可交互 p95 ≤1000 ms；应用进程冷启动另外报告 |
| 首次完整可点击图 | T1 根据开发集基线和产品交互目标逐规模冻结绝对毫秒上限；优化后同时满足绝对上限和同项目基线非退化（p95 不高于基线 105%）。没有绝对上限则 contract 无效 |
| 有效缓存与增量 | 各有独立绝对上限及相同非退化条件；待核验预览时间和正式可编辑时间分别报告 |
| 详情 | 冷/热均测点击至当前 revision 面板就绪，建议目标 p95 ≤300/100 ms；T1 冻结各档最终绝对上限。服务层耗时单独报告 |
| 内存与载荷 | 每档冻结完整进程树 RSS、首屏 IPC 字节、缓存驻留上限；超上限即失败，不允许只报主进程某一时刻 RSS |
| 长任务与取消 | 记录 >50 ms 渲染长任务的次数/总时长/最大值，冻结每档允许值；取消到 UI 接受操作目标 p95 ≤500 ms，后台任务退出及资源释放另测并设上限 |
| 统计完整性 | 每项目每场景至少 20 次，p95 使用 nearest-rank（ceil(0.95×n)）；保留所有运行与错误，正式验收错误率为零才通过本测试矩阵；基线产品错误完整保留，不因此抹去有效测量 |

前后版本使用 T0/T1a 封存产物与待验产物，在同机、同源码、同范围、同缓存定义下交错测量并记录机器负载；若原基线功能有缺失，另列支持范围一致的对照，不把多做的分析或旧版缺图伪装成退化/提速。若冻结目标无法达到，保留失败结果与原因，不能自行调低门槛。

### 7.2 语义质量与稳定性

- 默认确认调用：每条都有可定位源码证据；确定性夹具误报为零。真实标注集每语言精确率建议下限 98%、支持范围内可静态解析调用召回率建议下限 90%，由 T1 在开发集基线阶段正式冻结，之后不得因留出失败下调。
- 所有调用点、未解析、动态/不支持和外部目标分开报告，完整保留分母；不能缩小支持声明隐藏难例。仅 import 依赖对照不计入调用准确率。
- 模块质量：职责一致性、名称区分度、成员合理性、碎片化/过度合并各按 1–5 分独立评审；建议每项目每项均值 ≥4，T1 固定评分锚点、分歧处理与最终门槛。待判定模块数量/占比也必须公布。
- 身份与迁移：夹具中错误继承、丢失用户数据、混代与重复待处理项均为零；同输入/版本下结果确定。修改聚类策略必须验证人工修正和隐藏意图，不能只检查新图。
- 外部语义工具能否进入默认分析由 T2 约束，不能为达到召回率自动执行项目构建。达不到语言质量门槛则如实保留未完成状态。

### 7.3 视觉与交互

- 三档测试窗口及详情面板开启状态均可访问所有必要控件；无节点重叠、原点堆叠、分组长期隐藏或丢失聚合边。
- 默认可见卡标题的实际屏幕字号至少 14 CSS px，正文至少 12 CSS px；按渲染字号×缩放核验。无法全图适配时选择可读层级或局部导航，不降低字号。
- 相同输入、视口及用户状态产生相同节点排列；手工固定位置不被自动覆盖。局部展开时不受影响区域保持位置，明确触发全局整理的场景除外。
- 记录节点间空白占比、边交叉及边穿越非端点卡片情况，按拓扑与开发集基线冻结上限；不要求任意密集图零交叉。
- 搜索能定位折叠模块；键盘可进出分组并保留焦点；筛选明确计数与空态。聚合只改变显示，不删除事实和用户修正。

## 8. 要求到任务的覆盖矩阵

| 对话要求或历史问题 | 实施任务 | 核验依据 |
| --- | --- | --- |
| 新项目快速进入，明确正在分析 | T1、T8 | 目录选择起点的真实 Electron p95、无工具链/离线场景 |
| 具体功能模块，适用于多类项目 | T2–T4、T11 | 多仓库人工标注、留出质量、职责依据与待判定占比 |
| 准确调用与清楚的未知边界 | T2、T3 | 符号目标/调用位置、分语言精确率与召回率、完整分母 |
| 布局紧凑、整齐、可读、稳定 | T6、T7 | 三档窗口、聚合守恒、实际字号、拓扑截图和展开稳定性 |
| 控件合并与精简 | T7 | 单一筛选语义、旧偏好迁移、键盘/窄窗测试 |
| 分析期间编辑不丢，代际不混用 | T5、T8、T9 | 保存屏障、交错请求、分析中切换/关闭、写入失败恢复 |
| 评估随用户输入失效，人工覆盖保留 | T5、T9 | 保存/重开/重扫和当前修正详情测试 |
| 隐藏意图不误伤新职责 | T5 | 同 ID 新职责、事实变化、拆并、幂等迁移 |
| 详情读取快且新鲜 | T1、T9 | 同代不重复解析、revision 校验、冷热 20 次端到端测量 |
| 旧版跃迁到单一新结构 | T10 | 发布格式清单、实际消费者追踪、备份恢复与字段守恒 |
| 可商用开源借鉴且控制复杂度 | T2、T11 | 固定版本/许可证/NOTICE、采用决定与包体/性能证据 |
| 完整交付，不以打包成功替代验收 | T11 | 所有冻结门槛、完整测试、真实打包冒烟与发布条件 |

## 9. 执行记录方式与停止条件

每项完成记录只写：任务 ID、代码/规则指纹、运行命令、证据相对路径、通过/失败和未决原因。原始结果集中于 `docs/evidence/static-graph-generalization/`；大型/私密原始数据保存在受控位置，文档记录匿名样本 ID 与哈希，不把真实项目源码或秘密写进仓库。

出现数据丢失、混代、已知确认调用误报或不受控项目代码执行时，停止该任务的依赖任务，先复现和修复；其他独立工作可继续。涉及职责歧义或无法映射的历史数据，保持可恢复并进入审阅，不擅自做不可逆选择。

本计划交付的是实施顺序与验收契约。只有执行证据齐全后，才能把对应任务勾选为完成；只有本文件各项验收和承接的历史需求全部满足后，才能宣称静态加载重设计完成。旧文档本身不作为本轮执行记录的写入位置。

</details>

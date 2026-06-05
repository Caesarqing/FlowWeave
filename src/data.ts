import type { GraphEdge, GraphNode, LocaleId, ProjectFile } from "./types";

export const files: ProjectFile[] = [
  { name: "user-service", depth: 0, type: "folder" },
  { name: ".codex", depth: 1, type: "folder" },
  { name: "guidance.md", depth: 2, type: "file" },
  { name: "apps", depth: 1, type: "folder" },
  { name: "api", depth: 2, type: "folder" },
  { name: "src", depth: 3, type: "folder" },
  { name: "auth", depth: 4, type: "folder" },
  { name: "auth.guard.ts", depth: 5, type: "file" },
  { name: "jwt.strategy.ts", depth: 5, type: "file" },
  { name: "user", depth: 4, type: "folder" },
  { name: "user.controller.ts", depth: 5, type: "file", active: true },
  { name: "user.service.ts", depth: 5, type: "file" },
  { name: "database", depth: 4, type: "folder" },
  { name: "schema.prisma", depth: 5, type: "file" },
  { name: "docs", depth: 1, type: "folder" },
  { name: "architecture.md", depth: 2, type: "file" },
  { name: "AGENTS.md", depth: 1, type: "file" }
];

export const graphNodes: GraphNode[] = [
  {
    id: "intent",
    title: "Change Intent",
    subtitle: "需求入口与 Agent 指令边界",
    kind: "module",
    nodeType: "entrypoint",
    risk: "normal",
    description: "Codex 读取用户目标、项目约束和现有文档后，在这里形成可编辑的任务意图节点。",
    files: [".codex/guidance.md", "AGENTS.md", "docs/architecture.md"],
    guidanceDraft:
      "请先阅读 AGENTS.md 和 docs/architecture.md，确认本次只修改账号恢复相关路径，不重构无关模块。",
    status: "draft",
    x: 380,
    y: 60
  },
  {
    id: "auth",
    title: "Auth Module",
    subtitle: "登录态、JWT、权限守卫",
    kind: "module",
    nodeType: "module",
    risk: "normal",
    description: "负责身份校验和访问控制，是密码重置、邮箱验证等流程的安全边界。",
    files: ["apps/api/src/auth/auth.guard.ts", "apps/api/src/auth/jwt.strategy.ts", "apps/api/src/auth/token.service.ts"],
    guidanceDraft:
      "检查 Auth Module 的 token 生命周期，新增 password reset token 时保持现有 JWT 策略不变，并补充过期与重复使用保护。",
    status: "mapped",
    x: 90,
    y: 250
  },
  {
    id: "user-api",
    title: "User API",
    subtitle: "账户恢复与用户资料接口",
    kind: "module",
    nodeType: "module",
    risk: "review",
    description: "对外暴露用户相关 REST 接口，FlowWeave 将该节点作为本次修改的主工作区。",
    files: ["apps/api/src/user/user.controller.ts", "apps/api/src/user/user.service.ts", "apps/api/src/user/user.dto.ts"],
    guidanceDraft:
      "为 User API 增加 reset password 和 verify email 两类接口。保持 controller 只做请求编排，核心逻辑放在 service，并补充 DTO 校验。",
    status: "needs-review",
    x: 380,
    y: 250
  },
  {
    id: "persistence",
    title: "Persistence",
    subtitle: "用户、令牌与审计记录",
    kind: "module",
    nodeType: "data",
    risk: "normal",
    description: "维护数据库 schema、迁移和仓储访问，决定 Agent 修改时需要同步的持久化文件。",
    files: ["apps/api/src/database/user.repository.ts", "prisma/schema.prisma", "prisma/migrations"],
    guidanceDraft:
      "在 schema.prisma 中补充 passwordResetTokenHash、emailVerifiedAt 等字段，生成迁移时不要删除已有用户数据。",
    status: "mapped",
    x: 700,
    y: 250
  },
  {
    id: "tests",
    title: "Test Surface",
    subtitle: "集成测试与回归验证",
    kind: "module",
    nodeType: "test",
    risk: "normal",
    description: "记录 Codex 修改完成后必须覆盖的测试面，避免 FlowWeave 只生成实现指令而遗漏验证指令。",
    files: ["tests/integration/user.api.spec.ts", "tests/auth/reset-token.spec.ts"],
    guidanceDraft:
      "补充成功、过期 token、重复提交、非法邮箱四类测试。测试命令优先使用项目已有 package script。",
    status: "draft",
    x: 530,
    y: 455
  }
];

export const graphEdges: GraphEdge[] = [
  { id: "intent-auth", source: "intent", target: "auth", relation: "depends_on", guidanceNote: "需求先约束认证边界。" },
  { id: "intent-user-api", source: "intent", target: "user-api", relation: "calls", guidanceNote: "User API 是本次变更入口。" },
  { id: "intent-persistence", source: "intent", target: "persistence", relation: "reads_writes", guidanceNote: "持久化变更必须和接口变更同步。" },
  { id: "auth-user-api", source: "auth", target: "user-api", relation: "depends_on" },
  { id: "user-api-persistence", source: "user-api", target: "persistence", relation: "reads_writes" },
  { id: "user-api-tests", source: "user-api", target: "tests", relation: "tests" }
];

const englishGraphNodes: GraphNode[] = [
  {
    id: "intent",
    title: "Change Intent",
    subtitle: "Request entry and agent instruction boundary",
    kind: "module",
    nodeType: "entrypoint",
    risk: "normal",
    description: "Codex reads the user goal, project constraints, and existing docs, then forms an editable task intent node here.",
    files: [".codex/guidance.md", "AGENTS.md", "docs/architecture.md"],
    guidanceDraft:
      "Read AGENTS.md and docs/architecture.md first. Confirm this change only touches account recovery paths and does not refactor unrelated modules.",
    status: "draft",
    x: 380,
    y: 60
  },
  {
    id: "auth",
    title: "Auth Module",
    subtitle: "Session state, JWT, and permission guards",
    kind: "module",
    nodeType: "module",
    risk: "normal",
    description: "Owns identity checks and access control, forming the security boundary for password reset and email verification flows.",
    files: ["apps/api/src/auth/auth.guard.ts", "apps/api/src/auth/jwt.strategy.ts", "apps/api/src/auth/token.service.ts"],
    guidanceDraft:
      "Review the Auth Module token lifecycle. When adding password reset tokens, keep the existing JWT strategy unchanged and add expiry and replay protection.",
    status: "mapped",
    x: 90,
    y: 250
  },
  {
    id: "user-api",
    title: "User API",
    subtitle: "Account recovery and profile endpoints",
    kind: "module",
    nodeType: "module",
    risk: "review",
    description: "Exposes user-related REST endpoints and is the main workspace for this FlowWeave change.",
    files: ["apps/api/src/user/user.controller.ts", "apps/api/src/user/user.service.ts", "apps/api/src/user/user.dto.ts"],
    guidanceDraft:
      "Add reset password and verify email endpoints to User API. Keep the controller focused on request orchestration, put core logic in the service, and add DTO validation.",
    status: "needs-review",
    x: 380,
    y: 250
  },
  {
    id: "persistence",
    title: "Persistence",
    subtitle: "Users, tokens, and audit records",
    kind: "module",
    nodeType: "data",
    risk: "normal",
    description: "Maintains schema, migrations, and repository access that must stay aligned with agent-generated changes.",
    files: ["apps/api/src/database/user.repository.ts", "prisma/schema.prisma", "prisma/migrations"],
    guidanceDraft:
      "Add passwordResetTokenHash and emailVerifiedAt to schema.prisma. Do not delete existing user data when generating migrations.",
    status: "mapped",
    x: 700,
    y: 250
  },
  {
    id: "tests",
    title: "Test Surface",
    subtitle: "Integration tests and regression checks",
    kind: "module",
    nodeType: "test",
    risk: "normal",
    description: "Records the test surface required after Codex changes so implementation guidance does not omit verification.",
    files: ["tests/integration/user.api.spec.ts", "tests/auth/reset-token.spec.ts"],
    guidanceDraft:
      "Cover success, expired token, duplicate submission, and invalid email cases. Prefer the project's existing package scripts for test commands.",
    status: "draft",
    x: 530,
    y: 455
  }
];

const englishGraphEdges: GraphEdge[] = [
  { id: "intent-auth", source: "intent", target: "auth", relation: "depends_on", guidanceNote: "The request first constrains the auth boundary." },
  { id: "intent-user-api", source: "intent", target: "user-api", relation: "calls", guidanceNote: "User API is the entry point for this change." },
  { id: "intent-persistence", source: "intent", target: "persistence", relation: "reads_writes", guidanceNote: "Persistence changes must stay aligned with API changes." },
  { id: "auth-user-api", source: "auth", target: "user-api", relation: "depends_on" },
  { id: "user-api-persistence", source: "user-api", target: "persistence", relation: "reads_writes" },
  { id: "user-api-tests", source: "user-api", target: "tests", relation: "tests" }
];

export function createDefaultGraph(locale: LocaleId): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = locale === "zh-CN" ? graphNodes : englishGraphNodes;
  const edges = locale === "zh-CN" ? graphEdges : englishGraphEdges;
  return {
    nodes: nodes.map((node) => ({ ...node, files: [...node.files], symbols: node.symbols ? [...node.symbols] : undefined })),
    edges: edges.map((edge) => ({ ...edge, evidence: edge.evidence ? [...edge.evidence] : undefined }))
  };
}

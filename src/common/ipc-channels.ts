export const PROJECT_CHANNELS = {
  openProject: "project:open",
  scanProject: "project:scan",
  cancelOperation: "project:cancel-operation",
  operationProgress: "project:operation-progress",
  analyzeProject: "project:analyze",
  analyzeArchitecture: "project:analyze-architecture",
  analyzeArchitectureWithAgent: "project:analyze-architecture-with-agent",
  readArchitectureMap: "project:read-architecture-map",
  generateSequenceDiagrams: "project:generate-sequence-diagrams",
  reviseSequenceDiagram: "project:revise-sequence-diagram",
  readSequenceDiagrams: "project:read-sequence-diagrams",
  readFile: "project:read-file",
  saveDoc: "project:save-doc",
  readCanvas: "project:read-canvas",
  saveCanvas: "project:save-canvas",
  exportDiagnostics: "project:export-diagnostics",
  getAgentConnection: "project:get-agent-connection",
  enableAgentConnection: "project:enable-agent-connection",
  refreshAgentConnection: "project:refresh-agent-connection",
  disableAgentConnection: "project:disable-agent-connection",
  openAgentConnection: "project:open-agent-connection"
} as const;

export const TOOL_CHANNELS = {
  listAgents: "tool:list-agents",
  saveCustomAgent: "tool:save-custom-agent",
  deleteCustomAgent: "tool:delete-custom-agent",
  detectAgent: "tool:detect-agent",
  healthCheckAgent: "tool:health-check-agent",
  detect: "tool:detect",
  runPlan: "tool:run-plan",
  listRuns: "tool:list-runs",
  readRun: "tool:read-run",
  openProject: "tool:open-project"
} as const;

export const GIT_CHANNELS = {
  status: "git:status",
  diff: "git:diff",
  checkpoint: "git:checkpoint",
  rollback: "git:rollback"
} as const;

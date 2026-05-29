export const PROJECT_CHANNELS = {
  openProject: "project:open",
  scanProject: "project:scan",
  analyzeProject: "project:analyze",
  readFile: "project:read-file",
  saveDoc: "project:save-doc",
  readCanvas: "project:read-canvas",
  saveCanvas: "project:save-canvas"
} as const;

export const TOOL_CHANNELS = {
  detect: "tool:detect",
  runPlan: "tool:run-plan",
  openProject: "tool:open-project"
} as const;

export const GIT_CHANNELS = {
  status: "git:status",
  diff: "git:diff",
  checkpoint: "git:checkpoint",
  rollback: "git:rollback"
} as const;

export type ProjectFileNode = {
  id: string;
  name: string;
  path: string;
  type: "folder" | "file";
  depth: number;
  language?: string;
  children?: ProjectFileNode[];
};

export type ProjectFileRow = ProjectFileNode & {
  active?: boolean;
  isExpanded?: boolean;
  isTruncatedNotice?: boolean;
};

export type ProjectFile = {
  name: string;
  depth: number;
  type: "folder" | "file";
  active?: boolean;
  path?: string;
};

export type ActivePage = "canvas" | "structure" | "docs" | "git-review" | "tools";

export type GraphNodeStatus = "mapped" | "needs-review" | "draft";
export type GraphNodeType = "module" | "test" | "data" | "entrypoint";
export type GraphRisk = "normal" | "review" | "blocked";
export type GraphEdgeRelation = "depends_on" | "calls" | "reads_writes" | "tests";
export type CanvasNodeKind = "module" | "requirement" | "task" | "file" | "doc" | "agent" | "diff";

export type GraphNode = {
  id: string;
  title: string;
  subtitle: string;
  kind: CanvasNodeKind;
  nodeType: GraphNodeType;
  risk: GraphRisk;
  description: string;
  files: string[];
  guidanceDraft: string;
  status: GraphNodeStatus;
  x: number;
  y: number;
  acceptanceCriteria?: string[];
  priority?: "low" | "medium" | "high";
  docType?: "prd" | "readme" | "api-doc" | "task-spec";
  markdownContent?: string;
  toolId?: ToolId;
  executionMode?: ExecutionMode;
  checkpointId?: string;
  changedFiles?: ChangedFile[];
  patch?: string;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  guidanceNote?: string;
};

export type GitSummary = {
  isRepo: boolean;
  branch?: string;
  remote?: string;
  status?: string;
};

export type ProjectScanSummary = {
  totalFiles: number;
  totalFolders: number;
  languages: Record<string, number>;
  displayedEntries?: number;
  truncated?: boolean;
};

export type CodeflowProject = {
  version: 1;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  git: GitSummary;
  summary: ProjectScanSummary;
  files: ProjectFileNode[];
};

export type CodeflowCanvas = {
  version: 1;
  id: string;
  title: string;
  projectPath: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ToolId = "codex-local" | "claude-code" | "cursor" | "mock";
export type ExecutionMode = "plan" | "execute";

export type CodeflowTask = {
  version: 1;
  id: string;
  title: string;
  generatedAt: string;
  targetTools: ToolId[];
  modules: Array<{
    id: string;
    title: string;
    kind: CanvasNodeKind;
    nodeType: GraphNode["nodeType"];
    risk: GraphNode["risk"];
    description: string;
    files: string[];
    guidance: string;
  }>;
  relations: Array<{
    source: string;
    target: string;
    relation: GraphEdge["relation"];
    guidanceNote?: string;
  }>;
  acceptanceCriteria: string[];
};

export type CodeflowWriteResult = {
  projectJsonPath: string;
  canvasJsonPath: string;
  taskMarkdownPath: string;
  taskJsonPath: string;
  contextFileTreePath: string;
};

export type FlowWeaveProjectOpenResult =
  | { canceled: true }
  | {
      canceled: false;
      project: CodeflowProject;
      graph: {
        nodes: GraphNode[];
        edges: GraphEdge[];
      };
      written: CodeflowWriteResult;
    };

export type ToolKind = "cli" | "desktop" | "mock";
export type ToolRunStatus = "pending" | "running" | "completed" | "failed";

export type ToolRunEvent =
  | { type: "stdout"; content: string; timestamp: string }
  | { type: "stderr"; content: string; timestamp: string }
  | { type: "status"; status: ToolRunStatus; timestamp: string }
  | { type: "error"; message: string; timestamp: string };

export type ToolDetectionResult = {
  toolId: ToolId;
  available: boolean;
  method: "cli" | "app" | "mock" | "none";
  commandPath?: string;
  appPath?: string;
  version?: string;
  message?: string;
};

export type ToolOpenResult = {
  toolId: ToolId;
  opened: boolean;
  method: "cli" | "app" | "mock" | "none";
  message?: string;
};

export type ToolRunRequest = {
  id: string;
  projectPath: string;
  prompt: string;
  guidancePath?: string;
  executionMode: ExecutionMode;
  model?: string;
};

export type ToolRunResult = {
  id: string;
  toolId: ToolId;
  status: ToolRunStatus;
  projectPath: string;
  startedAt: string;
  completedAt: string;
  exitCode?: number | null;
  promptPath?: string;
  planPath?: string;
  logPath?: string;
  resultPath?: string;
  lastMessagePath?: string;
  summary?: string;
  stderr?: string;
  events: ToolRunEvent[];
  executionMode: ExecutionMode;
  checkpointId?: string;
};

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "copied" | "unknown";

export type ChangedFile = {
  path: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  previousPath?: string;
};

export type GitStatus = {
  isRepo: boolean;
  branch?: string;
  changedFiles: ChangedFile[];
  ahead?: number;
  behind?: number;
};

export type SafetyLevel = "ok" | "review" | "blocked";

export type SafetyWarning = {
  level: SafetyLevel;
  code: string;
  message: string;
  filePath?: string;
};

export type GitDiffResult = {
  isRepo: boolean;
  patch: string;
  changedFiles: ChangedFile[];
  safety: {
    level: SafetyLevel;
    warnings: SafetyWarning[];
  };
};

export type ProjectMap = {
  language: string;
  framework?: string;
  entryFiles: string[];
  directories: Array<{ path: string; purpose: string }>;
};

export type ModuleMap = {
  modules: Array<{
    id: string;
    title: string;
    description: string;
    files: string[];
    dependencies: Array<{ target: string; relation: GraphEdgeRelation }>;
    risk: GraphRisk;
  }>;
};

export type ApiMap = {
  endpoints: Array<{
    method: string;
    path: string;
    handler: string;
    description?: string;
  }>;
};

export type AgentAnalysisResult = {
  projectMap: ProjectMap;
  moduleMap: ModuleMap;
  apiMap?: ApiMap;
  source: "agent" | "fallback";
  agentOutput?: string;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
};

export interface ToolAdapter {
  id: ToolId;
  name: string;
  kind: ToolKind;
  detect(): Promise<ToolDetectionResult>;
  runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult>;
  openProject?(projectPath: string): Promise<ToolOpenResult>;
}

export type FlowWeaveApi = {
  openProject(): Promise<FlowWeaveProjectOpenResult>;
  scanProject(projectPath: string): Promise<FlowWeaveProjectOpenResult>;
  detectTool(toolId: ToolId): Promise<ToolDetectionResult>;
  runToolPlan(options: {
    projectPath: string;
    toolId: ToolId;
    prompt?: string;
    guidancePath?: string;
    executionMode?: ExecutionMode;
    model?: string;
  }): Promise<ToolRunResult>;
  openToolProject(toolId: ToolId, projectPath: string): Promise<ToolOpenResult>;
  gitStatus(projectPath: string): Promise<GitStatus>;
  gitDiff(projectPath: string, checkpointId?: string): Promise<GitDiffResult>;
  gitCheckpoint(projectPath: string): Promise<string>;
  gitRollback(projectPath: string, checkpointId: string): Promise<void>;
  analyzeProject(projectPath: string, toolId: ToolId): Promise<AgentAnalysisResult>;
  readProjectFile(projectPath: string, filePath: string): Promise<string>;
  saveFlowWeaveDoc(projectPath: string, docId: string, content: string): Promise<string>;
  readCanvas(projectPath: string): Promise<CodeflowCanvas | undefined>;
  saveCanvas(projectPath: string, canvas: CodeflowCanvas): Promise<string>;
};

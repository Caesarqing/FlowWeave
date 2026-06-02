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
export type UtilityPanel = "profile" | "settings";
export type UiThemeId = "system" | "light" | "dark" | "terminal" | "hologrid";
export type LocaleId = "en" | "zh-CN";

export type GraphNodeStatus = "mapped" | "needs-review" | "draft";
export type GraphNodeType = "module" | "entrypoint" | "api" | "service" | "data" | "external" | "worker" | "utility" | "test";
export type GraphRisk = "normal" | "review" | "blocked";
export type GraphEdgeRelation = "depends_on" | "calls" | "reads_writes" | "external_api" | "publishes_event" | "subscribes_event" | "tests";
export type CanvasNodeKind = "module" | "requirement" | "task" | "file" | "doc" | "agent" | "diff";

export type ConnectionHandleSlot = {
  id: string;
  edgeId?: string;
  offsetPercent: number;
  collapsed?: boolean;
  count: number;
  relation?: GraphEdgeRelation;
};

export type ConnectionHandleLayout = {
  source: ConnectionHandleSlot[];
  target: ConnectionHandleSlot[];
};

export type SelectedEdgeState = {
  edgeId: string;
  source: string;
  target: string;
};

export type ArchitectureModuleCategory =
  | "api-boundary"
  | "domain-service"
  | "data-access"
  | "external-integration"
  | "job-worker"
  | "shared-utility"
  | "test-surface";

export type StructureSymbolKind = "function" | "class" | "method" | "export" | "variable";

export type StructureSymbol = {
  name: string;
  kind: StructureSymbolKind;
  filePath: string;
  role?: string;
  exported?: boolean;
  line?: number;
};

export type ExternalCallInsight = {
  kind: "http" | "database" | "filesystem" | "process" | "queue" | "unknown";
  target: string;
  filePath: string;
  symbol?: string;
};

export type FileInsight = {
  path: string;
  language?: string;
  imports: string[];
  exports: string[];
  symbols: StructureSymbol[];
  calls: string[];
  externalCalls: ExternalCallInsight[];
  role?: string;
  moduleId?: string;
};

export type ArchitectureEvidence = {
  filePath?: string;
  symbol?: string;
  detail: string;
};

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
  category?: ArchitectureModuleCategory;
  role?: string;
  fileRoles?: Array<{ path: string; role: string }>;
  symbols?: StructureSymbol[];
  evidence?: ArchitectureEvidence[];
  confidence?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  guidanceNote?: string;
  evidence?: ArchitectureEvidence[];
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

export type ArchitectureModule = {
  id: string;
  title: string;
  category: ArchitectureModuleCategory;
  nodeType: GraphNodeType;
  role: string;
  description: string;
  files: string[];
  fileRoles: Array<{ path: string; role: string }>;
  symbols: StructureSymbol[];
  evidence: ArchitectureEvidence[];
  risk: GraphRisk;
  confidence?: number;
};

export type ArchitectureRelationship = {
  id: string;
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  description: string;
  evidence: ArchitectureEvidence[];
};

export type ProjectStructureFacts = {
  projectName: string;
  rootPath: string;
  languages: Record<string, number>;
  files: FileInsight[];
};

export type ArchitectureMap = {
  version: 1;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  source: "agent" | "fallback";
  architectureStyle?: string;
  modules: ArchitectureModule[];
  relationships: ArchitectureRelationship[];
  files: FileInsight[];
  symbols: StructureSymbol[];
};

export type SequenceDiagramKind = "architectural" | "detailed-design";
export type SequenceDiagramSource = "agent" | "fallback";
export type SequenceParticipantKind =
  | "actor"
  | "component"
  | "service"
  | "gateway"
  | "database"
  | "external"
  | "controller"
  | "class"
  | "interface"
  | "repository"
  | "worker"
  | "utility";
export type SequenceMessageKind = "sync" | "async" | "return" | "event" | "external";

export type SequenceParticipant = {
  id: string;
  title: string;
  kind: SequenceParticipantKind;
  description: string;
  filePath?: string;
  symbol?: string;
};

export type SequenceMessage = {
  id: string;
  sequence: number;
  from: string;
  to: string;
  kind: SequenceMessageKind;
  label: string;
  description?: string;
  methodName?: string;
  input?: string;
  output?: string;
  evidence?: ArchitectureEvidence[];
};

export type SequenceDiagram = {
  id: string;
  title: string;
  kind: SequenceDiagramKind;
  summary: string;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  evidence?: ArchitectureEvidence[];
};

export type SequenceDiagramBundle = {
  version: 1;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  source: SequenceDiagramSource;
  architectural: SequenceDiagram;
  detailedDesign: SequenceDiagram;
};

export type SequenceDiagramGenerationOutcome = "generated" | "cached" | "fallback";

export type SequenceDiagramGenerationResult = {
  bundle: SequenceDiagramBundle;
  outcome: SequenceDiagramGenerationOutcome;
  warning?: string;
};

export type BuiltInAgentId = "codex-local" | "claude-code" | "cursor";
export type ToolId = BuiltInAgentId | "mock";
export type CustomAgentId = `custom:${string}`;
export type AgentId = BuiltInAgentId | CustomAgentId;
export type RuntimeAgentId = AgentId | "mock";
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
  toolId: RuntimeAgentId;
  available: boolean;
  method: "cli" | "app" | "mock" | "none";
  commandPath?: string;
  appPath?: string;
  version?: string;
  message?: string;
};

export type ToolUiStatus = ToolDetectionResult & {
  checking: boolean;
  lastRunStatus?: ToolRunStatus;
  lastOutputPath?: string;
};

export type AgentDefinition = {
  id: AgentId;
  name: string;
  kind: "cli" | "desktop";
  command: string;
  args: string[];
  description: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CustomAgentInput = {
  name: string;
  command: string;
  args?: string[];
  description?: string;
};

export type ToolOpenResult = {
  toolId: RuntimeAgentId;
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
  toolId: RuntimeAgentId;
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

export type ToolRunSummary = {
  id: string;
  toolId: RuntimeAgentId;
  status: ToolRunStatus;
  executionMode: ExecutionMode;
  startedAt: string;
  completedAt: string;
  summary?: string;
  promptPath?: string;
  planPath?: string;
  logPath?: string;
  resultPath?: string;
  checkpointId?: string;
};

export type ToolRunArtifact = {
  summary: ToolRunSummary;
  prompt: string;
  plan: string;
  log: string;
  result: string;
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

export type ArchitectureAnalysisResult = {
  architectureMap: ArchitectureMap;
  source: "agent" | "fallback";
  agentOutput?: string;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
};

export interface ToolAdapter {
  id: RuntimeAgentId;
  name: string;
  kind: ToolKind;
  detect(): Promise<ToolDetectionResult>;
  runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult>;
  openProject?(projectPath: string): Promise<ToolOpenResult>;
}

export type FlowWeaveApi = {
  openProject(): Promise<FlowWeaveProjectOpenResult>;
  scanProject(projectPath: string): Promise<FlowWeaveProjectOpenResult>;
  listAgents(): Promise<AgentDefinition[]>;
  saveCustomAgent(input: CustomAgentInput): Promise<AgentDefinition>;
  deleteCustomAgent(agentId: AgentId): Promise<void>;
  detectAgent(agentId: RuntimeAgentId): Promise<ToolDetectionResult>;
  detectTool(toolId: ToolId): Promise<ToolDetectionResult>;
  runToolPlan(options: {
    projectPath: string;
    toolId: RuntimeAgentId;
    prompt?: string;
    guidancePath?: string;
    executionMode?: ExecutionMode;
    model?: string;
  }): Promise<ToolRunResult>;
  listToolRuns(projectPath: string): Promise<ToolRunSummary[]>;
  readToolRun(projectPath: string, runId: string): Promise<ToolRunArtifact>;
  openToolProject(toolId: ToolId, projectPath: string): Promise<ToolOpenResult>;
  gitStatus(projectPath: string): Promise<GitStatus>;
  gitDiff(projectPath: string, checkpointId?: string): Promise<GitDiffResult>;
  gitCheckpoint(projectPath: string): Promise<string>;
  gitRollback(projectPath: string, checkpointId: string): Promise<void>;
  analyzeProject(projectPath: string, toolId: ToolId): Promise<AgentAnalysisResult>;
  analyzeArchitecture(projectPath: string, toolId: ToolId): Promise<ArchitectureAnalysisResult>;
  analyzeArchitectureWithAgent(projectPath: string, agentId: RuntimeAgentId): Promise<ArchitectureAnalysisResult>;
  readArchitectureMap(projectPath: string): Promise<ArchitectureMap | undefined>;
  generateSequenceDiagrams(projectPath: string, agentId: RuntimeAgentId): Promise<SequenceDiagramGenerationResult>;
  reviseSequenceDiagram(projectPath: string, agentId: RuntimeAgentId, kind: SequenceDiagramKind, instruction: string): Promise<SequenceDiagramBundle>;
  readSequenceDiagrams(projectPath: string): Promise<SequenceDiagramBundle | undefined>;
  readProjectFile(projectPath: string, filePath: string): Promise<string>;
  saveFlowWeaveDoc(projectPath: string, docId: string, content: string): Promise<string>;
  readCanvas(projectPath: string): Promise<CodeflowCanvas | undefined>;
  saveCanvas(projectPath: string, canvas: CodeflowCanvas): Promise<string>;
};

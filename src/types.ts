export type ProjectFileNode = {
  id: string;
  name: string;
  path: string;
  type: "folder" | "file";
  depth: number;
  language?: string;
  size?: number;
  modifiedAt?: string;
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
export type WorkspacePanelSide = "left" | "right";
export type WorkspacePanelPage = ActivePage;
export type WorkspacePanelPreferences = Record<WorkspacePanelPage, Record<WorkspacePanelSide, boolean>>;

export type GraphNodeStatus = "mapped" | "needs-review" | "draft";
export type GraphNodeType = "module" | "entrypoint" | "api" | "service" | "data" | "external" | "worker" | "utility" | "test";
export type AssessmentLevel = "low" | "medium" | "high" | "unknown";
export type LegacyGraphRisk = "normal" | "review" | "blocked";
export type GraphRisk = AssessmentLevel;
export type AssessmentFactor = {
  id: string;
  label: string;
  score: number;
  maxScore: number;
  reason: string;
  evidence: ArchitectureEvidence[];
};
export type AssessmentScore = {
  score?: number;
  level: AssessmentLevel;
  factors: AssessmentFactor[];
};
export type RiskAssessment = {
  systemScore?: number;
  systemLevel: AssessmentLevel;
  effectiveLevel: AssessmentLevel;
  previousSystemLevel?: AssessmentLevel;
  systemLevelChanged?: boolean;
  factors: AssessmentFactor[];
  override?: {
    level: Exclude<AssessmentLevel, "unknown">;
    reason: string;
    createdAt: string;
  };
};
export type ModuleAssessment = {
  version: 1;
  generatorVersion: string;
  confidence: AssessmentScore;
  risk: RiskAssessment;
  fingerprint: string;
  assessedAt: string;
};
export type TechnologyStack = "frontend" | "backend" | "mobile" | "data" | "infrastructure" | "shared" | "unknown";
export type ArchitectureLayer = "presentation" | "api" | "domain" | "data" | "integration" | "infrastructure" | "test" | "unknown";
export type CanvasLayoutMode = "dependency" | "technology" | "architecture" | "functional";
export type CanvasPosition = { x: number; y: number };
export type CanvasLayoutState = {
  activeMode: "manual" | CanvasLayoutMode;
  manualPositions: Record<string, CanvasPosition>;
  autoLayouts: Partial<Record<CanvasLayoutMode, Record<string, CanvasPosition>>>;
  collapsedGroups: string[];
};
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
  signature?: string;
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
  line?: number;
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
  assessment?: ModuleAssessment;
  technologyStack?: TechnologyStack;
  architectureLayer?: ArchitectureLayer;
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

export type ProjectScanOptions = {
  maxEntries: number;
  concurrency: number;
};

export type CodeflowProject = {
  version: 1 | 2;
  generatorVersion?: string;
  inputFingerprint?: string;
  artifactState?: ProjectArtifactState;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  git: GitSummary;
  summary: ProjectScanSummary;
  files: ProjectFileNode[];
  scanFingerprint?: string;
  scanDelta?: ScanDelta;
};

export type AnalysisDepth = "semantic" | "syntax" | "lightweight";
export type SemanticFileStatus = "parsed" | "unsupported" | "failed";
export type SemanticRelationKind =
  | "import"
  | "call"
  | "inherit"
  | "render"
  | "http"
  | "database"
  | "filesystem"
  | "process"
  | "event"
  | "test";
export type SemanticRelationConfidence = "confirmed" | "inferred";

export type SemanticDiagnostic = {
  code: string;
  severity: "warning" | "error";
  message: string;
  filePath: string;
};

export type SemanticFile = {
  path: string;
  language?: string;
  framework?: string;
  size: number;
  modifiedAt: string;
  contentHash: string;
  cacheKey: string;
  analyzerId: string;
  analysisDepth: AnalysisDepth;
  status: SemanticFileStatus;
  diagnostics: SemanticDiagnostic[];
  insight?: FileInsight;
  httpEndpoints: SemanticHttpEndpoint[];
  renderTargets: string[];
};

export type SemanticHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "UNKNOWN";

export type SemanticHttpEndpoint = {
  id: string;
  kind: "request" | "route";
  filePath: string;
  method: SemanticHttpMethod;
  path: string;
  normalizedPath: string;
  symbol?: string;
  confidence: SemanticRelationConfidence;
};

export type SemanticRelation = {
  id: string;
  kind: SemanticRelationKind;
  source: string;
  target: string;
  sourceFile: string;
  targetFile?: string;
  symbol?: string;
  detail: string;
  confidence: SemanticRelationConfidence;
};

export type SemanticIndex = {
  version: 1;
  generatorVersion: string;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  scanFingerprint: string;
  files: SemanticFile[];
  symbols: StructureSymbol[];
  relations: SemanticRelation[];
  httpEndpoints: SemanticHttpEndpoint[];
  diagnostics: SemanticDiagnostic[];
};

export type SemanticIndexManifestEntry = {
  path: string;
  size: number;
  modifiedAt: string;
  contentHash: string;
  cacheKey: string;
};

export type SemanticIndexManifest = {
  version: 1;
  generatorVersion: string;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  scanFingerprint: string;
  configurationFingerprint?: string;
  files: SemanticIndexManifestEntry[];
};

export type ScanDelta = {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
};

export type CodeflowCanvas = {
  version: 1 | 2 | 3;
  generatorVersion?: string;
  inputFingerprint?: string;
  id: string;
  title: string;
  projectPath: string;
  generatedAt: string;
  scanFingerprint?: string;
  artifactState?: ProjectArtifactState;
  layout?: CanvasLayoutState;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ProjectArtifactState = "current" | "stale" | "missing" | "failed";

export type ProjectArtifactStatuses = {
  project: ProjectArtifactState;
  canvas: ProjectArtifactState;
  task: ProjectArtifactState;
  context: ProjectArtifactState;
  architecture: ProjectArtifactState;
  sequences: ProjectArtifactState;
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
  assessment?: ModuleAssessment;
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
  relations?: SemanticRelation[];
};

export type ArchitectureMap = {
  version: 1 | 2;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  source: "agent" | "fallback";
  metadata?: ArtifactGenerationMetadata;
  architectureStyle?: string;
  modules: ArchitectureModule[];
  relationships: ArchitectureRelationship[];
  files: FileInsight[];
  symbols: StructureSymbol[];
};

export type SequenceDiagramKind = "architectural";
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
  version: 1 | 2;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  source: SequenceDiagramSource;
  metadata?: ArtifactGenerationMetadata;
  architectural: SequenceDiagram;
};

export type ArtifactGenerationMetadata = {
  agentId: RuntimeAgentId;
  runId: string;
  generatedAt: string;
  inputFingerprint: string;
  fileCoverage: number;
  evidenceCoverage: number;
};

export type AnalysisFailure = {
  code: "agent-failed" | "invalid-output" | "quality-rejected";
  message: string;
  agentId: RuntimeAgentId;
  category?: ToolRunFailureCode;
  transient?: boolean;
  technicalDetails?: string;
  runId?: string;
  attemptRunIds?: string[];
  firstFailure?: string;
  retryFailure?: string;
};

export type SequenceDiagramGenerationResult =
  | { outcome: "generated"; bundle: SequenceDiagramBundle; warning?: AnalysisFailure }
  | { outcome: "cached"; bundle: SequenceDiagramBundle; error: AnalysisFailure }
  | { outcome: "failed"; error: AnalysisFailure };

export type BuiltInAgentId = "claude-code" | "claude-desktop" | "codex-local" | "codex-desktop" | "gemini-cli" | "cursor";
export type ToolId = BuiltInAgentId | "mock";
export type CustomAgentId = `custom:${string}`;
export type AgentId = BuiltInAgentId | CustomAgentId;
export type RuntimeAgentId = AgentId | "mock";
export type ExecutionMode = "plan" | "execute";
export type ToolRunPurpose = "implementation-plan" | "artifact-analysis";
export type AsyncOperationStatus = "idle" | "running" | "succeeded" | "failed";
export type AsyncOperationState = { status: AsyncOperationStatus; error?: string };
export type AnalysisOperationStage =
  | "discovery"
  | "hashing"
  | "parsing"
  | "linking"
  | "analyzing"
  | "validating"
  | "persisting"
  | "completed"
  | "canceled"
  | "failed";
export type AnalysisProgressUpdate = {
  stage: AnalysisOperationStage;
  completed: number;
  total: number;
  failed: number;
  message: string;
};
export type AnalysisOperation = {
  operationId: string;
  kind: "project-scan" | "architecture-analysis" | "sequence-analysis";
  stage: AnalysisOperationStage;
  completed: number;
  total: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  message: string;
};

export type FlowWeaveErrorCategory = "validation" | "security" | "filesystem" | "agent" | "canceled" | "internal";
export type FlowWeaveErrorData = {
  code: string;
  category: FlowWeaveErrorCategory;
  message: string;
  context: Record<string, string | number | boolean | undefined>;
  suggestedActions: string[];
  technicalDetails?: string;
};

export type AnalysisGenerationOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgressUpdate) => void;
  planTimeoutMs?: number;
};

export type ProjectAgentPlatform = "codex" | "claude" | "gemini" | "cursor";
export type ProjectAgentConnectionConfig = {
  version: 1;
  enabled: boolean;
  platforms: ProjectAgentPlatform[];
  updatedAt: string;
};
export type ProjectAgentConnectionState = "ready" | "needs-refresh" | "disabled" | "failed";
export type ProjectAgentConnectionStatus = {
  state: ProjectAgentConnectionState;
  enabled: boolean;
  needsConfirmation: boolean;
  projectPath: string;
  contextPath: string;
  configPath: string;
  generatedFiles: string[];
  platforms: ProjectAgentPlatform[];
  updatedAt?: string;
  message: string;
};

export type CodeflowTask = {
  version: 1 | 2;
  generatorVersion?: string;
  inputFingerprint?: string;
  artifactState?: ProjectArtifactState;
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
      projectId: string;
      scanFingerprint: string;
      artifacts: ProjectArtifactStatuses;
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
  | { type: "status"; status: ToolRunStatus; timestamp: string; message?: string }
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

export type AgentHealthCheckSeverity = "ok" | "warning" | "error";
export type AgentHealthCheckStatus = "passed" | "warning" | "failed";
export type AgentHealthCheck = {
  id: string;
  label: string;
  status: AgentHealthCheckStatus;
  message: string;
};
export type AgentHealthCheckResult = {
  agentId: RuntimeAgentId;
  severity: AgentHealthCheckSeverity;
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  environmentHints: string[];
  checkedAt: string;
};

export type ToolUiStatus = ToolDetectionResult & {
  checking: boolean;
  health?: AgentHealthCheckResult;
  lastRunStatus?: ToolRunStatus;
  lastOutputPath?: string;
};

export type AgentDefinition = {
  id: AgentId;
  name: string;
  kind: "cli" | "desktop";
  protocol?: AgentProtocol;
  command: string;
  args: string[];
  planArgs?: string[];
  executeArgs?: string[];
  appPath?: string;
  bridgeInstructions?: string;
  capabilities?: AgentCapability[];
  description: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AgentProtocol = "cli-stdin" | "desktop-bridge";
export type AgentCapability = "artifact-analysis" | "implementation-plan" | "execute";

export type CustomAgentInput = {
  name: string;
  protocol?: AgentProtocol;
  command?: string;
  args?: string[];
  planArgs?: string[];
  executeArgs?: string[];
  appPath?: string;
  bridgeInstructions?: string;
  capabilities?: AgentCapability[];
  description?: string;
};

export type AgentJobType = "architecture-map" | "sequence-diagram" | "implementation-plan";

export type ToolOpenResult = {
  toolId: RuntimeAgentId;
  opened: boolean;
  method: "cli" | "app" | "mock" | "none";
  message?: string;
};

export type ToolRunRequest = {
  id: string;
  projectId: string;
  projectPath: string;
  prompt: string;
  guidancePath?: string;
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
  model?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
};

export type AgentRunPolicy = {
  timeoutMs: number;
  maxOutputBytes: number;
  retryCount: number;
  retryDelayMs: number;
};

export type ToolRunTerminationReason = "completed" | "failed" | "timeout" | "canceled" | "output-limit";
export type ToolRunFailureCode =
  | "authentication"
  | "connection"
  | "rate-limit"
  | "provider"
  | "timeout"
  | "invalid-output"
  | "process";
export type ToolRunOutputSource = "stdout" | "stderr" | "error" | "last-message";
export type ToolRunFailure = {
  code: ToolRunFailureCode;
  message: string;
  transient: boolean;
  source: ToolRunOutputSource;
  exitCode?: number | null;
  providerDetails?: string;
  suggestedActions?: string[];
};

export type ToolRunResult = {
  id: string;
  projectId?: string;
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
  outputText?: string;
  failure?: ToolRunFailure;
  events: ToolRunEvent[];
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
  checkpointId?: string;
  attempts?: number;
  durationMs?: number;
  outputTruncated?: boolean;
  terminationReason?: ToolRunTerminationReason;
};

export type ToolRunSummary = {
  id: string;
  toolId: RuntimeAgentId;
  status: ToolRunStatus;
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
  startedAt: string;
  completedAt: string;
  summary?: string;
  promptPath?: string;
  planPath?: string;
  logPath?: string;
  resultPath?: string;
  checkpointId?: string;
  failure?: ToolRunFailure;
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

export type ArchitectureAnalysisResult =
  | {
      outcome: "generated";
      architectureMap: ArchitectureMap;
      graph: { nodes: GraphNode[]; edges: GraphEdge[] };
      runId?: string;
      warning?: AnalysisFailure;
    }
  | {
      outcome: "failed";
      error: AnalysisFailure;
      previous?: ArtifactGenerationMetadata;
    };

export interface ToolAdapter {
  id: RuntimeAgentId;
  name: string;
  kind: ToolKind;
  detect(): Promise<ToolDetectionResult>;
  healthCheck?(): Promise<AgentHealthCheckResult>;
  runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult>;
  openProject?(projectPath: string): Promise<ToolOpenResult>;
}

export type FlowWeaveApi = {
  onFlowWeaveError(listener: (error: FlowWeaveErrorData) => void): () => void;
  openProject(options: ProjectScanOptions): Promise<FlowWeaveProjectOpenResult>;
  scanProject(projectId: string, options: ProjectScanOptions): Promise<FlowWeaveProjectOpenResult>;
  cancelOperation(operationId: string): Promise<AnalysisOperation>;
  onOperationProgress(listener: (operation: AnalysisOperation) => void): () => void;
  listAgents(): Promise<AgentDefinition[]>;
  saveCustomAgent(input: CustomAgentInput): Promise<AgentDefinition>;
  deleteCustomAgent(agentId: AgentId): Promise<void>;
  detectAgent(agentId: RuntimeAgentId): Promise<ToolDetectionResult>;
  healthCheckAgent(agentId: RuntimeAgentId): Promise<AgentHealthCheckResult>;
  detectTool(toolId: ToolId): Promise<ToolDetectionResult>;
  runToolPlan(options: {
    projectId: string;
    toolId: RuntimeAgentId;
    prompt: string;
    guidancePath?: string;
    executionMode: ExecutionMode;
    purpose: ToolRunPurpose;
    model?: string;
    confirmedExecute?: boolean;
    executeTimeoutMs?: number;
    planTimeoutMs?: number;
  }): Promise<ToolRunResult>;
  listToolRuns(projectId: string): Promise<ToolRunSummary[]>;
  readToolRun(projectId: string, runId: string): Promise<ToolRunArtifact>;
  openToolProject(agentId: RuntimeAgentId, projectId: string): Promise<ToolOpenResult>;
  gitStatus(projectId: string): Promise<GitStatus>;
  gitDiff(projectId: string, checkpointId?: string): Promise<GitDiffResult>;
  gitCheckpoint(projectId: string): Promise<string>;
  gitRollback(projectId: string, checkpointId: string): Promise<void>;
  analyzeProject(projectId: string, toolId: ToolId): Promise<AgentAnalysisResult>;
  analyzeArchitecture(projectId: string, toolId: ToolId): Promise<ArchitectureAnalysisResult>;
  analyzeArchitectureWithAgent(projectId: string, agentId: RuntimeAgentId): Promise<ArchitectureAnalysisResult>;
  readArchitectureMap(projectId: string): Promise<ArchitectureMap | undefined>;
  generateSequenceDiagrams(projectId: string, agentId: RuntimeAgentId, planTimeoutMs?: number): Promise<SequenceDiagramGenerationResult>;
  reviseSequenceDiagram(projectId: string, agentId: RuntimeAgentId, instruction: string, planTimeoutMs?: number): Promise<SequenceDiagramBundle>;
  readSequenceDiagrams(projectId: string): Promise<SequenceDiagramBundle | undefined>;
  readProjectFile(projectId: string, filePath: string): Promise<string>;
  saveFlowWeaveDoc(projectId: string, docId: string, content: string): Promise<string>;
  readCanvas(projectId: string): Promise<CodeflowCanvas | undefined>;
  saveCanvas(projectId: string, canvas: CodeflowCanvas): Promise<string>;
  exportDiagnostics(projectId: string): Promise<string>;
  getProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  enableProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  refreshProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  disableProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  openProjectAgentConnection(projectId: string): Promise<void>;
};

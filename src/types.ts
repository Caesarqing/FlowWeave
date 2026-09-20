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
export type CanvasLayoutMode = "execution" | "dependency" | "role" | "runtime" | "domain" | "technology" | "architecture" | "functional";
export type CanvasClassification = {
  role: ArchitectureLayer;
  runtimeTags: TechnologyStack[];
  domain: string;
};
export type CanvasPosition = { x: number; y: number };
export type CanvasLayoutState = {
  activeMode: "manual" | CanvasLayoutMode;
  manualPositions: Record<string, CanvasPosition>;
  autoLayouts: Partial<Record<CanvasLayoutMode, Record<string, CanvasPosition>>>;
  collapsedGroups: string[];
};
export type GraphEdgeRelation = "depends_on" | "calls" | "reads_writes" | "external_api" | "publishes_event" | "subscribes_event" | "tests";
export type GraphViewMode = "execution" | "dependency" | "architecture" | "technology" | "domain";
export type GraphEdgeClass = "runtime" | "data" | "external" | "event" | "dependency" | "test";
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
  eventId?: string;
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
  technologyTags?: TechnologyStack[];
  architectureLayer?: ArchitectureLayer;
  classification?: CanvasClassification;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  guidanceNote?: string;
  evidence?: ArchitectureEvidence[];
};

export type NormalizedModule = {
  id: string;
  title: string;
  nodeType: GraphNodeType;
  description: string;
  files: string[];
  guidanceDraft: string;
  riskOverride?: {
    level: Exclude<AssessmentLevel, "unknown">;
    reason: string;
  };
};

export type NormalizedRelation = {
  id: string;
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  guidanceNote?: string;
};

export type ModificationSnapshot = {
  scanFingerprint?: string;
  canvas: {
    modules: NormalizedModule[];
    relations: NormalizedRelation[];
  };
  sequenceInstruction?: string;
};

export type ModificationBaseline = ModificationSnapshot & {
  version: 1;
  acknowledgedAt: string;
  moduleGuidanceAcknowledgements?: Record<string, string>;
};

export type ModificationDelta = {
  modules: {
    added: NormalizedModule[];
    updated: Array<{
      id: string;
      title: string;
      changes: Partial<NormalizedModule>;
    }>;
    deleted: Array<{ id: string; title: string }>;
  };
  relations: {
    added: NormalizedRelation[];
    updated: Array<{
      id: string;
      changes: Partial<NormalizedRelation>;
    }>;
    deleted: Array<{
      id: string;
      source: string;
      target: string;
    }>;
  };
  sequenceInstruction?: string;
};

export type ModificationAcknowledgementScope =
  | { kind: "all" }
  | { kind: "module-guidance"; moduleId: string }
  | { kind: "sequence" };

export type ModificationGuidanceContext = {
  schemaVersion: 2;
  source: "FlowWeave";
  generatedAt: string;
  project: {
    label: string;
    path: string;
    scanFingerprint?: string;
  };
  delta: ModificationDelta;
  hasChanges: boolean;
  artifactReferences: string[];
};

export type ModificationDeltaResult = {
  baseline: ModificationBaseline;
  snapshot: ModificationSnapshot;
  delta: ModificationDelta;
  hasChanges: boolean;
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
  version: 1 | 2 | 3 | 4;
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
  version: 1 | 2 | 3 | 4;
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
  version: 4;
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

export type ArchitectureReviewState =
  | "local"
  | "reviewing"
  | "reviewed"
  | "review-failed"
  | "stale"
  | "missing";

export type ArchitectureDiffCounts = {
  modules: {
    added: number;
    removed: number;
    modified: number;
  };
  relationships: {
    added: number;
    removed: number;
    modified: number;
  };
};

export type ArchitectureReviewError = {
  code: "agent-failed" | "invalid-output" | "quality-rejected" | "persistence-failed";
  message: string;
};

export type ArchitectureReviewStatus = {
  state: ArchitectureReviewState;
  projectId?: string;
  artifactTarget?: "architecture-map";
  reviewId?: string;
  scanFingerprint?: string;
  inputFingerprint?: string;
  agentId?: RuntimeAgentId;
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  softTimedOutAt?: string;
  message?: string;
  diff?: ArchitectureDiffCounts;
  error?: ArchitectureReviewError;
};

export type ArchitectureReviewEvent = {
  projectId: string;
  reviewId: string;
  scanFingerprint: string;
  status: ArchitectureReviewStatus;
  architectureMap?: ArchitectureMap;
  graph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
};

export type SequenceReviewState =
  | "local"
  | "reviewing"
  | "reviewed"
  | "review-failed"
  | "stale"
  | "missing";

export type SequenceDiffCounts = {
  participants: {
    added: number;
    removed: number;
    modified: number;
  };
  messages: {
    added: number;
    removed: number;
    modified: number;
  };
};

export type SequenceReviewError = {
  code: "agent-failed" | "invalid-output" | "quality-rejected" | "persistence-failed";
  message: string;
};

export type SequenceReviewStatus = {
  state: SequenceReviewState;
  reviewId?: string;
  scanFingerprint?: string;
  agentId?: RuntimeAgentId;
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  softTimedOutAt?: string;
  message?: string;
  diff?: SequenceDiffCounts;
  error?: SequenceReviewError;
};

export type SequenceReviewEvent = {
  projectId: string;
  reviewId: string;
  scanFingerprint: string;
  status: SequenceReviewStatus;
  bundle?: SequenceDiagramBundle;
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
  source: "agent" | "local";
  metadata?: ArtifactGenerationMetadata;
  architectureStyle?: string;
  modules: ArchitectureModule[];
  relationships: ArchitectureRelationship[];
  files: FileInsight[];
  symbols: StructureSymbol[];
};

export type SequenceDiagramKind = "architectural";
export type SequenceDiagramSource = "agent" | "local";
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
  version: 2;
  projectName: string;
  rootPath: string;
  generatedAt: string;
  source: SequenceDiagramSource;
  metadata?: ArtifactGenerationMetadata;
  architectural: SequenceDiagram;
};

export type ArtifactGenerationMetadata = {
  source?: "agent" | "local";
  agentId?: RuntimeAgentId;
  runId?: string;
  reviewId?: string;
  generatedAt: string;
  scanFingerprint?: string;
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

export type LocalGenerationStatus = "idle" | "generating" | "local-ready" | "failed";

export type SequenceDiagramGenerationResult =
  | { outcome: "generated"; bundle: SequenceDiagramBundle; review: SequenceReviewStatus; warning?: AnalysisFailure }
  | { outcome: "cached"; bundle: SequenceDiagramBundle; error: AnalysisFailure }
  | { outcome: "failed"; error: AnalysisFailure };

export type BuiltInAgentId = "claude-code" | "claude-desktop" | "codex-local" | "codex-desktop" | "gemini-cli" | "cursor";
export type ToolId = BuiltInAgentId | "mock";
export type CustomAgentId = `custom:${string}`;
export type AgentId = BuiltInAgentId | CustomAgentId;
export type RuntimeAgentId = AgentId | "mock";
export type ExecutionMode = "plan" | "execute";
export type ToolRunPurpose = "implementation-plan" | "artifact-analysis";
export type ArtifactRunTarget = "architecture-map" | "sequence-diagrams" | "sequence-revision";
export type AgentProtocolVersion = 2;
export type AgentExpectedContentKind = "artifact-json" | "markdown-plan";
export type ArtifactAdoptionStatus = "not-applicable" | "pending" | "late" | "applied" | "rejected" | "stale";
export type ArtifactAdoption = {
  status: ArtifactAdoptionStatus;
  message: string;
  appliedAt?: string;
};
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
  projectId: string;
  kind: "project-scan" | "architecture-analysis" | "sequence-analysis";
  stage: AnalysisOperationStage;
  completed: number;
  total: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  message: string;
};

export type FlowWeaveErrorCategory = "validation" | "security" | "filesystem" | "agent" | "internal";
export type FlowWeaveErrorData = {
  code: string;
  category: FlowWeaveErrorCategory;
  message: string;
  context: Record<string, string | number | boolean | undefined>;
  suggestedActions: string[];
  technicalDetails?: string;
};

export type AnalysisGenerationOptions = {
  onProgress?: (progress: AnalysisProgressUpdate) => void;
  projectId?: string;
  onArchitectureReview?: (event: ArchitectureReviewEvent) => void;
  resumeArchitectureReview?: ArchitectureReviewStatus;
  onSequenceReview?: (event: SequenceReviewEvent) => void;
  resumeSequenceReview?: SequenceReviewStatus;
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
      architectureReview: ArchitectureReviewStatus;
      sequenceReview: SequenceReviewStatus;
      project: CodeflowProject;
      graph: {
        nodes: GraphNode[];
        edges: GraphEdge[];
      };
      written: CodeflowWriteResult;
    };

export type RegisteredProject = {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
};

export type ProjectWorkspaceSession = {
  openProjectIds: string[];
  activeProjectId?: string;
  lastPageByProject: Partial<Record<string, ActivePage>>;
  contextsByProject: Partial<Record<string, ProjectWorkspaceContext>>;
};

export type ProjectWorkspaceContext = {
  activePage: ActivePage;
  expandedPaths: string[];
  selectedNodeId: string;
  selectedAgentId: AgentId;
  executionMode: ExecutionMode;
  selectedRunId: string;
  runArtifactTab: "prompt" | "plan" | "log" | "result";
  checkpointId: string;
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
  blocking?: boolean;
};
export type AgentHealthCheckResult = {
  agentId: RuntimeAgentId;
  projectId?: string;
  severity: AgentHealthCheckSeverity;
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  environmentHints: string[];
  connection?: ProjectAgentConnectionStatus;
  checkedAt: string;
};

export type AgentReadinessResult = AgentHealthCheckResult & {
  refreshedConnection?: boolean;
};

export type ToolUiStatus = ToolDetectionResult & {
  checking: boolean;
  health?: AgentReadinessResult;
  lastRunStatus?: ToolRunStatus;
  lastOutputPath?: string;
};

export type AgentDefinition = {
  id: AgentId;
  name: string;
  kind: "cli" | "desktop";
  protocol?: AgentProtocol;
  protocolVersion?: AgentProtocolVersion;
  pluginId?: string;
  pluginStatus?: AgentPluginInstallState;
  installTarget?: string;
  command: string;
  args: string[];
  planArgs?: string[];
  executeArgs?: string[];
  appPath?: string;
  capabilities?: AgentCapability[];
  description: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AgentDiscoverySource = "builtin" | "user-manifest" | "project-manifest";

export type AgentDiscoveryResult = {
  definition: AgentDefinition;
  availability: ToolDetectionResult;
  source: AgentDiscoverySource;
};

export type AgentProtocol = "agent-inbox";
export type AgentCapability = "artifact-analysis" | "implementation-plan" | "execute";
export type AgentPluginHostId = "codex" | "claude" | "gemini" | "cursor";
export type AgentPluginInstallState = "missing" | "installed" | "outdated" | "unavailable" | "error";
export type AgentPluginHostManifest = {
  id: AgentPluginHostId;
  displayName: string;
  installTarget: string;
  capabilities: AgentCapability[];
  protocols: AgentProtocol[];
};
export type AgentPluginManifest = {
  id: string;
  name: string;
  version: string;
  protocolVersion: AgentProtocolVersion;
  description: string;
  hosts: AgentPluginHostManifest[];
};
export type AgentPluginStatus = {
  pluginId: string;
  hostId: AgentPluginHostId;
  displayName: string;
  status: AgentPluginInstallState;
  installedVersion?: string;
  bundledVersion: string;
  installTarget: string;
  hostInstructionPath?: string;
  message: string;
};
export type AgentPluginHostCheck = {
  hostId: AgentPluginHostId;
  status: "installed" | "error";
  requiredFiles: string[];
  missingFiles: string[];
  version: string;
  protocolVersion: AgentProtocolVersion;
  contentHash: string;
  message: string;
};
export type AgentPluginMigrationResult = {
  status: "not-run" | "completed" | "blocked" | "failed";
  completedAt?: string;
  migratedFiles?: Array<{
    sourcePath: string;
    targetPath: string;
    contentHash: string;
  }>;
  message?: string;
};
export type AgentPluginState = {
  schemaVersion: 1;
  pluginId: string;
  installedVersion: string;
  protocolVersion: AgentProtocolVersion;
  contentHash: string;
  installedAt: string;
  sourceHash: string;
  hostChecks: AgentPluginHostCheck[];
  recentMigrationResult: AgentPluginMigrationResult;
};

export type CustomAgentInput = {
  name: string;
  protocol?: AgentProtocol;
  command?: string;
  args?: string[];
  planArgs?: string[];
  executeArgs?: string[];
  appPath?: string;
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
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  inputFingerprint?: string;
  reviewId?: string;
  protocolVersion?: AgentProtocolVersion;
  expectedContentKind?: AgentExpectedContentKind;
  pluginHint?: string;
  model?: string;
};

export type AgentRunPolicy = {
  retryCount: number;
  retryDelayMs: number;
};

export type ToolRunTerminationReason = "completed" | "failed";
export type ToolRunFailureCode =
  | "authentication"
  | "connection"
  | "model-not-found"
  | "rate-limit"
  | "provider"
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
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  inputFingerprint?: string;
  reviewId?: string;
  artifactAdoption?: ArtifactAdoption;
  agentReadiness?: AgentReadinessResult;
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
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  inputFingerprint?: string;
  reviewId?: string;
  artifactAdoption?: ArtifactAdoption;
  agentReadiness?: AgentReadinessResult;
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

export type ApiMap = {
  endpoints: Array<{
    method: string;
    path: string;
    handler: string;
    description?: string;
  }>;
};

export type ArchitectureAnalysisResult =
  | {
      outcome: "generated";
      localGenerationStatus: "local-ready";
      architectureMap: ArchitectureMap;
      graph: { nodes: GraphNode[]; edges: GraphEdge[] };
      review: ArchitectureReviewStatus;
      runId?: string;
      warning?: AnalysisFailure;
    }
  | {
      outcome: "failed";
      localGenerationStatus: "failed";
      error: AnalysisFailure;
      previous?: ArtifactGenerationMetadata;
    };

export interface ToolAdapter {
  id: RuntimeAgentId;
  name: string;
  kind: ToolKind;
  detect(): Promise<ToolDetectionResult>;
  healthCheck?(options?: { runModelProbe: boolean }): Promise<AgentHealthCheckResult>;
  runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult>;
  openProject?(projectPath: string): Promise<ToolOpenResult>;
}

export type FlowWeaveApi = {
  onFlowWeaveError(listener: (error: FlowWeaveErrorData) => void): () => void;
  openProject(options: ProjectScanOptions): Promise<FlowWeaveProjectOpenResult>;
  listRegisteredProjects(): Promise<RegisteredProject[]>;
  restoreRegisteredProject(projectId: string, options: ProjectScanOptions): Promise<FlowWeaveProjectOpenResult>;
  readProjectWorkspaceSession(): Promise<ProjectWorkspaceSession>;
  saveProjectWorkspaceSession(session: ProjectWorkspaceSession): Promise<void>;
  scanProject(projectId: string, options: ProjectScanOptions): Promise<FlowWeaveProjectOpenResult>;
  onOperationProgress(listener: (operation: AnalysisOperation) => void): () => void;
  onArchitectureReview(listener: (event: ArchitectureReviewEvent) => void): () => void;
  onSequenceReview(listener: (event: SequenceReviewEvent) => void): () => void;
  listAgents(): Promise<AgentDefinition[]>;
  discoverAgents(projectId?: string): Promise<AgentDiscoveryResult[]>;
  saveCustomAgent(input: CustomAgentInput): Promise<AgentDefinition>;
  deleteCustomAgent(agentId: AgentId): Promise<void>;
  detectAgent(agentId: RuntimeAgentId, projectId?: string): Promise<ToolDetectionResult>;
  healthCheckAgent(agentId: RuntimeAgentId, projectId?: string): Promise<AgentReadinessResult>;
  detectTool(toolId: ToolId): Promise<ToolDetectionResult>;
  runToolPlan(options: {
    projectId: string;
    toolId: RuntimeAgentId;
    prompt: string;
    guidancePath?: string;
    executionMode: ExecutionMode;
    purpose: ToolRunPurpose;
    artifactTarget?: ArtifactRunTarget;
    scanFingerprint?: string;
    reviewId?: string;
    model?: string;
    confirmedExecute?: boolean;
  }): Promise<ToolRunResult>;
  listToolRuns(projectId: string): Promise<ToolRunSummary[]>;
  readToolRun(projectId: string, runId: string): Promise<ToolRunArtifact>;
  applyRunArtifact(projectId: string, runId: string): Promise<ToolRunSummary>;
  openAgentInbox(projectId: string, runId: string): Promise<void>;
  openToolProject(agentId: RuntimeAgentId, projectId: string): Promise<ToolOpenResult>;
  getAgentPluginStatuses(projectId: string): Promise<AgentPluginStatus[]>;
  installAgentPlugin(projectId: string): Promise<AgentPluginStatus[]>;
  openAgentPlugin(projectId: string): Promise<void>;
  openAgentPluginInstructions(projectId: string, hostId: AgentPluginHostId): Promise<void>;
  gitStatus(projectId: string): Promise<GitStatus>;
  gitDiff(projectId: string, checkpointId?: string): Promise<GitDiffResult>;
  gitCheckpoint(projectId: string): Promise<string>;
  gitRollback(projectId: string, checkpointId: string): Promise<void>;
  analyzeArchitectureWithAgent(projectId: string, agentId: RuntimeAgentId): Promise<ArchitectureAnalysisResult>;
  readArchitectureMap(projectId: string): Promise<ArchitectureMap | undefined>;
  generateSequenceDiagrams(projectId: string, agentId: RuntimeAgentId): Promise<SequenceDiagramGenerationResult>;
  reviseSequenceDiagram(projectId: string, agentId: RuntimeAgentId, instruction: string): Promise<SequenceDiagramBundle>;
  readSequenceDiagrams(projectId: string): Promise<SequenceDiagramBundle | undefined>;
  readProjectFile(projectId: string, filePath: string): Promise<string | undefined>;
  saveFlowWeaveDoc(projectId: string, docId: string, content: string): Promise<string>;
  saveModificationDocs(projectId: string, sequenceInstruction?: string): Promise<{
    guidancePath: string;
    contextPath: string;
  }>;
  readModificationDelta(
    projectId: string,
    sequenceInstruction?: string,
    canvas?: CodeflowCanvas
  ): Promise<ModificationDeltaResult>;
  acknowledgeModificationChanges(
    projectId: string,
    snapshot: ModificationSnapshot,
    scope: ModificationAcknowledgementScope
  ): Promise<ModificationBaseline>;
  readCanvas(projectId: string): Promise<CodeflowCanvas | undefined>;
  saveCanvas(projectId: string, canvas: CodeflowCanvas, options?: { allowStaleNoop?: boolean }): Promise<string>;
  exportDiagnostics(projectId: string): Promise<string>;
  getProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  enableProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  refreshProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  disableProjectAgentConnection(projectId: string): Promise<ProjectAgentConnectionStatus>;
  openProjectAgentConnection(projectId: string): Promise<void>;
};

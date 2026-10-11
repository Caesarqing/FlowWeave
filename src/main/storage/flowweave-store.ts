import { graphNodeShapeIssue, graphEdgeShapeIssue } from "./canvas-shape";
import { TransactionRecoveryError } from "../services/generation-errors";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArchitectureMap, CanvasLayoutState, CanvasMigrationReviewRequest, CanvasSaveReceipt, CanvasUserStateV1, CodeflowCanvas, ConnectionHandleLayout, ConnectionHandleSlot, GenerationIdentity, GraphEdgeRelation, GraphOverviewV1, ProjectGenerationManifestV7, SemanticIndex, StaticSnapshotV1 } from "../../types";
import { canvasMigrationPendingItemId } from "../../utils/canvas-migration";
import { canvasFromGraphOverview, createCanvasUserState, createGraphOverview, isLegacyCanvasV1To4, reconcileGeneratedCanvas, type CanvasForGeneration, type StoredCanvas } from "../services/canvas-migration.service";
import { applyAssessmentOverride, unknownAssessment } from "../../utils/module-assessment";
import { assertSafeProjectWritePath } from "./project-write-guard";
import { readJsonArtifact } from "./artifact-store";
import { FLOWWEAVE_DIR } from "./flowweave-paths";
import { syncDirectory } from "./directory-sync";
import { markTransactionCleanupStarted, removeTransactionAuthority, verifyTransactionAuthority, writeTransactionAuthority } from "./transaction-authority";
import type { CodeflowProject, CodeflowWriteResult } from "./schemas";

export type ArchitectureArtifacts = {
  generation?: GenerationIdentity;
  requestId?: string;
  semanticIndex?: SemanticIndex;
  local: ArchitectureMap;
  current: ArchitectureMap;
  previousGraph?: Pick<CodeflowCanvas, "nodes" | "edges">;
};

const protocolV7ArtifactPaths = new Set(["static-snapshot.json", "graph-overview.json", "canvas/user-state.json"]);
const legacyMigrationArtifacts = [
  ["project.json", isSupportedLegacyProjectArtifact],
  ["architecture-local.json", isSupportedLegacyLocalArchitectureArtifact],
  ["architecture-map.json", isSupportedLegacyArchitectureArtifact]
] as const;

export async function prepareFlowWeaveProject(
  rootPath: string,
  project: CodeflowProject,
  generatedCanvas: CodeflowCanvas,
  architectureArtifacts: ArchitectureArtifacts | undefined
) {
  const flowweaveRoot = join(rootPath, FLOWWEAVE_DIR);
  const canvasDir = join(flowweaveRoot, "canvas");
  await assertSafeProjectWritePath(rootPath, flowweaveRoot);
  await assertMigrationInventoryUnchanged(rootPath, architectureArtifacts?.requestId, undefined);
  const currentManifest = await readProjectGenerationManifest(rootPath);
  const existingCanvas = await readCanvasForGeneration(rootPath);
  await mkdir(canvasDir, { recursive: true });

  const nextCanvas: CodeflowCanvas = reconcileGeneratedCanvas(
    generatedCanvas,
    existingCanvas,
    architectureArtifacts?.previousGraph,
    architectureArtifacts?.semanticIndex && new Set(architectureArtifacts.semanticIndex.files.map((file) => file.path))
  );
  let responseCanvas = nextCanvas;
  const updates: Array<{ path: string; content: string; validate?: (content: string) => void }> = [];
  if (architectureArtifacts?.current.source === "agent") {
    updates.push({ path: join(flowweaveRoot, "architecture-map.json"), content: jsonText(architectureArtifacts.current) });
  }
  let canvasPath = join(canvasDir, "user-state.json");
  if (architectureArtifacts?.generation && architectureArtifacts.semanticIndex) {
    const generationId = architectureArtifacts.generation.requestId;
    const userStatePath = join(canvasDir, "user-state.json");
    const existingUserState = await readProtocolUserState(rootPath, generationId);
    const existingRevision = existingCanvas && "userRevision" in existingCanvas ? existingCanvas.userRevision : undefined;
    const revision = existingUserState?.revision ?? existingRevision ?? 0;
    responseCanvas = { ...nextCanvas, userRevision: revision };
    const snapshot: StaticSnapshotV1 = {
      schemaVersion: 1,
      generationId,
      inputFingerprint: architectureArtifacts.generation.inputFingerprint,
      generatedAt: new Date().toISOString(),
      project: { ...project, generation: architectureArtifacts.generation },
      semanticIndex: architectureArtifacts.semanticIndex,
      localArchitecture: architectureArtifacts.local
    };
    const overview: GraphOverviewV1 = {
      ...createGraphOverview(generatedCanvas, generationId),
      inputFingerprint: architectureArtifacts.generation.inputFingerprint,
      project: snapshot.project,
      architectureInputFingerprint: architectureArtifacts.local.metadata?.inputFingerprint,
      relationDiagnostics: architectureArtifacts.current.relationDiagnostics ?? [],
      resources: architectureArtifacts.current.resources ?? []
    };
    const userState = createCanvasUserState(generatedCanvas, nextCanvas, generationId, revision);
    responseCanvas = canvasFromGraphOverview(overview, userState, rootPath, architectureArtifacts.generation);
    updates.push(
      { path: join(flowweaveRoot, "static-snapshot.json"), content: `${JSON.stringify(snapshot)}\n` },
      { path: join(flowweaveRoot, "graph-overview.json"), content: jsonText(overview) },
      { path: userStatePath, content: jsonText(userState) }
    );
    canvasPath = userStatePath;
  }
  const removedPaths: string[] = [];
  const recordPath = join(flowweaveRoot, "migration", "record.json");
  const migrationRecord = await readMigrationRecord(recordPath);
  const expectedRequestId = architectureArtifacts?.requestId;
  const migrationRequired = !currentManifest && (existingCanvas !== undefined || migrationRecord?.status === "in-progress");
  if (migrationRequired && (!migrationRecord || migrationRecord.status !== "in-progress" || (expectedRequestId && migrationRecord.requestId !== expectedRequestId))) {
    throw new Error(`Legacy project migration record is missing or inactive: ${recordPath}`);
  }
  if (migrationRequired && migrationRecord) {
    updates.push({ path: recordPath, content: jsonText({
      ...migrationRecord,
      status: "complete",
      completedAt: new Date().toISOString(),
      pendingItemCount: nextCanvas.migrationPendingItems?.length ?? 0,
      failure: undefined
    }) });
    removedPaths.push(join(canvasDir, "main.canvas.json"), join(flowweaveRoot, "project.json"), join(flowweaveRoot, "architecture-local.json"));
    if (architectureArtifacts?.current.source !== "agent") removedPaths.push(join(flowweaveRoot, "architecture-map.json"));
  }
  const validateMigration = async () => assertMigrationInventoryUnchanged(rootPath, expectedRequestId, migrationRequired ? migrationRecord : undefined);
  return { updates, removedPaths, validateMigration, canvas: responseCanvas, written: {
    generationManifestPath: join(flowweaveRoot, "generation.json"),
    staticSnapshotPath: join(flowweaveRoot, "static-snapshot.json"),
    graphOverviewPath: join(flowweaveRoot, "graph-overview.json"),
    canvasUserStatePath: canvasPath
  } };
}

export async function readProjectGenerationManifest(projectPath: string): Promise<ProjectGenerationManifestV7 | undefined> {
  const value = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "generation.json"));
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`FlowWeave generation marker is invalid and was preserved: ${join(projectPath, FLOWWEAVE_DIR, "generation.json")}`);
  if (value.storageProtocol === undefined) {
    if (typeof value.requestId === "string" && typeof value.inputFingerprint === "string") return undefined;
    throw new Error(`FlowWeave generation marker has an unknown schema and was preserved: ${join(projectPath, FLOWWEAVE_DIR, "generation.json")}`);
  }
  if (value.storageProtocol !== 7 || typeof value.generationId !== "string" || !value.generationId ||
    typeof value.inputFingerprint !== "string" || !value.inputFingerprint || typeof value.rulesVersion !== "string" ||
    typeof value.analyzerVersion !== "string" || typeof value.committedAt !== "string" || !isRecord(value.artifacts)) {
    throw new Error(`FlowWeave generation manifest is invalid and was preserved: ${join(projectPath, FLOWWEAVE_DIR, "generation.json")}`);
  }
  for (const key of ["staticSnapshot", "graphOverview", "canvasUserState"] as const) {
    if (typeof value.artifacts[key] !== "string" || !/^[a-f\d]{64}$/i.test(value.artifacts[key])) {
      throw new Error(`FlowWeave generation manifest artifact hash is invalid: ${key}`);
    }
  }
  const expectedGenerationId = createHash("sha256").update(JSON.stringify({
    storageProtocol: 7,
    rulesVersion: value.rulesVersion,
    inputFingerprint: value.inputFingerprint
  })).digest("hex");
  if (value.generationId !== expectedGenerationId) throw new Error(`FlowWeave generation ID does not match its input and rule versions: project ${projectPath}`);
  return value as ProjectGenerationManifestV7;
}

export async function requireProjectProtocolV7(projectPath: string): Promise<ProjectGenerationManifestV7> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest) throw new Error(`Project has not been migrated to FlowWeave protocol v7: ${projectPath}`);
  return manifest;
}

export async function readProjectProtocolCanvas(projectPath: string): Promise<CodeflowCanvas | undefined> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest) return undefined;
  const root = join(projectPath, FLOWWEAVE_DIR);
  const userStatePath = join(root, "canvas", "user-state.json");
  const [overview, userStateText] = await Promise.all([
    readProjectProtocolOverview(projectPath),
    readVerifiedArtifact(userStatePath, manifest.artifacts.canvasUserState)
  ]);
  if (!overview) throw new Error(`FlowWeave committed graph overview is missing: project ${projectPath}, generation ${manifest.generationId}`);
  const userState = parseJson<CanvasUserStateV1>(userStateText, userStatePath);
  if (userState.schemaVersion !== 1 || userState.generationId !== manifest.generationId || !Number.isInteger(userState.revision) || userState.revision < 0 ||
    !isRecord(userState.nodeEdits) || !isRecord(userState.edgeEdits) || !Array.isArray(userState.manualNodes) || !Array.isArray(userState.manualEdges) ||
    !Array.isArray(userState.orphanedEdges) || !Array.isArray(userState.orphanedNodeEdits) || !Array.isArray(userState.migrationPendingItems) ||
    (userState.migrationReviewActions !== undefined && !Array.isArray(userState.migrationReviewActions)) ||
    (userState.assessmentInvalidations !== undefined && (!isRecord(userState.assessmentInvalidations) ||
      Object.values(userState.assessmentInvalidations).some((fingerprint) => typeof fingerprint !== "string" || !/^[a-f\d]{64}$/i.test(fingerprint)))) ||
    (userState.riskOverrides !== undefined && (!isRecord(userState.riskOverrides) ||
      Object.values(userState.riskOverrides).some((override) => !isRecord(override) || !["low", "medium", "high"].includes(String(override.level)) ||
        typeof override.reason !== "string" || !override.reason.trim() || typeof override.createdAt !== "string" ||
        (override.systemLevelAtOverride !== undefined && !["low", "medium", "high", "unknown"].includes(String(override.systemLevelAtOverride))))))) {
    throw new Error(`FlowWeave committed overview or user state is invalid: project ${projectPath}, generation ${manifest.generationId}`);
  }
  return canvasFromGraphOverview(overview, userState, projectPath, {
    requestId: manifest.generationId,
    inputFingerprint: manifest.inputFingerprint
  });
}

export async function readProjectProtocolCanvasForDisplay(projectPath: string): Promise<CodeflowCanvas | undefined> {
  const canvas = await readProjectProtocolCanvas(projectPath);
  if (!canvas) return undefined;
  const { orphanedEdges, orphanedNodeEdits, migrationPendingItems, quality, ...display } = canvas;
  return {
    ...display,
    ...(quality ? { quality: { ...quality, factOutcomes: quality.factOutcomes?.map((outcome) => ({ ...outcome, relationIds: [] })) } } : {}),
    preservedCounts: {
      pending: migrationPendingItems?.length ?? 0,
      nodeEdits: orphanedNodeEdits?.length ?? 0,
      edges: orphanedEdges?.length ?? 0
    }
  };
}

export async function readProjectProtocolOverview(projectPath: string): Promise<GraphOverviewV1 | undefined> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest) return undefined;
  const path = join(projectPath, FLOWWEAVE_DIR, "graph-overview.json");
  const content = await readVerifiedArtifact(path, manifest.artifacts.graphOverview);
  const overview = parseJson<GraphOverviewV1>(content, path);
  if (overview.schemaVersion !== 1 || overview.generationId !== manifest.generationId || overview.inputFingerprint !== manifest.inputFingerprint ||
    !Array.isArray(overview.nodes) || !Array.isArray(overview.edges) || !Array.isArray(overview.relationDiagnostics) || !Array.isArray(overview.resources)) {
    throw new Error(`FlowWeave committed graph overview is invalid: project ${projectPath}, generation ${manifest.generationId}`);
  }
  if (overview.project && ((await realpath(overview.project.rootPath)) !== (await realpath(projectPath)) || overview.project.generation?.requestId !== manifest.generationId)) {
    throw new Error(`FlowWeave committed graph overview project is invalid: project ${projectPath}, generation ${manifest.generationId}`);
  }
  for (const [index, node] of overview.nodes.entries()) {
    if (!isRecord(node)) throw new Error(`FlowWeave graph overview is invalid: ${path}: nodes[${index}] must be an object`);
  }
  for (const [index, edge] of overview.edges.entries()) {
    if (!isRecord(edge)) throw new Error(`FlowWeave graph overview is invalid: ${path}: edges[${index}] must be an object`);
  }
  return overview;
}

export async function readProjectProtocolSnapshot(
  projectPath: string,
  onMeasurement?: (metric: "snapshotReadMs" | "snapshotParseMs" | "snapshotValidationMs", durationMs: number, outcome: "completed" | "failed") => void
): Promise<StaticSnapshotV1 | undefined> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest) return undefined;
  const path = join(projectPath, FLOWWEAVE_DIR, "static-snapshot.json");
  const readStartedAt = onMeasurement ? performance.now() : undefined;
  let readOutcome: "completed" | "failed" = "failed";
  let content: string;
  try {
    content = await readVerifiedArtifact(path, manifest.artifacts.staticSnapshot);
    readOutcome = "completed";
  } finally {
    if (readStartedAt !== undefined) onMeasurement?.("snapshotReadMs", performance.now() - readStartedAt, readOutcome);
  }
  const parseStartedAt = onMeasurement ? performance.now() : undefined;
  let parseOutcome: "completed" | "failed" = "failed";
  let snapshot: StaticSnapshotV1;
  try {
    snapshot = parseJson<StaticSnapshotV1>(content, path);
    parseOutcome = "completed";
  } finally {
    if (parseStartedAt !== undefined) onMeasurement?.("snapshotParseMs", performance.now() - parseStartedAt, parseOutcome);
  }
  const validationStartedAt = onMeasurement ? performance.now() : undefined;
  let validationOutcome: "completed" | "failed" = "failed";
  try {
    if (snapshot.schemaVersion !== 1 || snapshot.generationId !== manifest.generationId || snapshot.inputFingerprint !== manifest.inputFingerprint ||
      snapshot.project.generation?.requestId !== manifest.generationId || snapshot.semanticIndex.generation?.requestId !== manifest.generationId ||
      snapshot.localArchitecture.generation?.requestId !== manifest.generationId) {
      throw new Error(`FlowWeave committed static snapshot is invalid: project ${projectPath}, generation ${manifest.generationId}`);
    }
    validationOutcome = "completed";
    return snapshot;
  } finally {
    if (validationStartedAt !== undefined) onMeasurement?.("snapshotValidationMs", performance.now() - validationStartedAt, validationOutcome);
  }
}

export async function saveProjectProtocolCanvas(projectPath: string, canvas: CodeflowCanvas): Promise<CanvasSaveReceipt | undefined> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest) return undefined;
  const current = await readProjectProtocolCanvas(projectPath);
  const state = await readProtocolUserState(projectPath, manifest.generationId);
  if (!current || !state) throw new Error(`Current protocol v7 Canvas state is missing: project ${projectPath}, generation ${manifest.generationId}`);
  if (canvas.generation?.requestId !== manifest.generationId || canvas.generation.inputFingerprint !== manifest.inputFingerprint ||
    canvas.scanFingerprint !== current.scanFingerprint) {
    throw new Error(`Canvas save rejected because the project generation changed: project ${projectPath}, expected ${manifest.generationId}, received ${canvas.generation?.requestId ?? "missing"}`);
  }
  if (canvas.userRevision !== state.revision) {
    throw new Error(`Canvas save rejected because user state changed: project ${projectPath}, expected revision ${state.revision}, received ${canvas.userRevision ?? "missing"}`);
  }
  const nodeIds = new Set(canvas.nodes.map((node) => node.id));
  if (nodeIds.size !== canvas.nodes.length) {
    throw new Error(`Canvas save rejected because it contains a duplicate node ID: project ${projectPath}`);
  }
  const edgeIds = new Set(canvas.edges.map((edge) => edge.id));
  if (edgeIds.size !== canvas.edges.length) {
    throw new Error(`Canvas save rejected because it contains a duplicate relation ID: project ${projectPath}`);
  }
  for (const edge of canvas.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`Canvas save rejected because relation ${edge.id} has a missing endpoint: project ${projectPath}, source ${edge.source}, target ${edge.target}`);
    }
  }
  const snapshot = await readProjectProtocolSnapshot(projectPath);
  if (!snapshot) throw new Error(`Canvas save rejected because the static snapshot is missing: project ${projectPath}`);
  const knownFiles = new Set(snapshot.semanticIndex.files.map((file) => file.path));
  const fileOwners = new Map<string, string>();
  for (const node of canvas.nodes) {
    if (node.origin === "manual" || node.kind !== "module") continue;
    for (const file of node.files) {
      if (!knownFiles.has(file)) {
        throw new Error(`Canvas save rejected because module ${node.id} contains unknown source file ${file}: project ${projectPath}`);
      }
      const owner = fileOwners.get(file);
      if (owner && owner !== node.id) {
        throw new Error(`Canvas save rejected because source file ${file} belongs to multiple generated modules (${owner}, ${node.id}): project ${projectPath}`);
      }
      fileOwners.set(file, node.id);
    }
  }
  const generated = canvasFromGraphOverview(
    parseJson(await readVerifiedArtifact(join(projectPath, FLOWWEAVE_DIR, "graph-overview.json"), manifest.artifacts.graphOverview), join(projectPath, FLOWWEAVE_DIR, "graph-overview.json")),
    emptyCanvasUserState(manifest.generationId), projectPath,
    { requestId: manifest.generationId, inputFingerprint: manifest.inputFingerprint }
  );
  const nextState = createCanvasUserState(generated, {
    ...canvas,
    orphanedEdges: state.orphanedEdges,
    orphanedNodeEdits: state.orphanedNodeEdits,
    migrationPendingItems: state.migrationPendingItems,
    migrationReviewActions: state.migrationReviewActions ?? []
  }, manifest.generationId, state.revision + 1);
  const stateContent = jsonText(nextState);
  const nextManifest: ProjectGenerationManifestV7 = {
    ...manifest,
    artifacts: { ...manifest.artifacts, canvasUserState: contentHash(stateContent) }
  };
  const userStatePath = join(projectPath, FLOWWEAVE_DIR, "canvas", "user-state.json");
  await writeBatchAtomic(projectPath, [
    { path: userStatePath, content: stateContent },
    { path: join(projectPath, FLOWWEAVE_DIR, "generation.json"), content: jsonText(nextManifest) }
  ]);
  return { path: userStatePath, userRevision: nextState.revision, generationId: manifest.generationId };
}

export async function resolveCanvasMigrationItem(
  projectPath: string,
  request: CanvasMigrationReviewRequest
): Promise<CanvasSaveReceipt> {
  if (!request.generationId || !Number.isInteger(request.userRevision) || request.userRevision < 0 ||
    !request.item.id || !["node-edit", "edge", "migration-pending"].includes(request.item.kind) ||
    !["rebind", "keep", "discard"].includes(request.action)) {
    throw new Error(`Canvas migration review request is invalid: project ${projectPath}`);
  }
  const manifest = await requireProjectProtocolV7(projectPath);
  if (manifest.generationId !== request.generationId) {
    throw new Error(`Canvas migration review rejected because the project generation changed: project ${projectPath}, expected ${manifest.generationId}, received ${request.generationId}`);
  }
  const current = await readProjectProtocolCanvas(projectPath);
  const state = await readProtocolUserState(projectPath, manifest.generationId);
  if (!current || !state) throw new Error(`Canvas migration review rejected because current user state is missing: project ${projectPath}`);
  if (state.revision !== request.userRevision) {
    throw new Error(`Canvas migration review rejected because user state revision changed: project ${projectPath}, expected ${state.revision}, received ${request.userRevision}`);
  }
  const nextRevision = state.revision + 1;
  const timestamp = new Date().toISOString();
  let nextCanvas: CodeflowCanvas = { ...current };
  let decision: CanvasUserStateV1["migrationReviewActions"][number] = {
    kind: request.item.kind,
    itemId: request.item.id,
    action: request.action,
    generationId: manifest.generationId,
    revision: nextRevision,
    ...(request.targetNodeId ? { targetNodeId: request.targetNodeId } : {}),
    ...(request.sourceNodeId ? { sourceNodeId: request.sourceNodeId } : {})
  };

  if (request.item.kind === "node-edit") {
    const orphanedNodeEdits = current.orphanedNodeEdits ?? [];
    const matches = orphanedNodeEdits.filter((item) => item.node.id === request.item.id);
    if (matches.length !== 1) throw new Error(`Canvas migration review node edit is missing or ambiguous: project ${projectPath}, item ${request.item.id}`);
    const orphan = matches[0];
    if (request.action === "rebind") {
      if (!request.targetNodeId) throw new Error(`Canvas migration node edit rebind requires a target node ID: item ${request.item.id}`);
      const target = current.nodes.find((node) => node.id === request.targetNodeId && node.origin !== "manual" && node.kind === "module" && !node.resource);
      if (!target) throw new Error(`Canvas migration node edit rebind target is not a current generated module: ${request.targetNodeId}`);
      const edits = orphan.edits;
      if (!edits || Object.keys(edits).length === 0) {
        throw new Error(`Canvas migration node edit has no verified user-field delta and cannot be rebound safely: ${request.item.id}`);
      }
      const { assessment, x, y, ...editableFields } = edits;
      const override = assessment?.risk.override;
      const hasTransferableField = Object.keys(editableFields).length > 0 || Boolean(override) || (x !== undefined && y !== undefined);
      if (!hasTransferableField) {
        throw new Error(`Canvas migration node edit has no rebindable user content or position: ${request.item.id}`);
      }
      const rebound = {
        ...target,
        ...editableFields,
        id: target.id,
        origin: target.origin,
        ...(Object.keys(editableFields).length > 0 || override ? { status: "needs-review" as const } : {}),
        ...(override ? {
          risk: override.level,
          assessment: applyAssessmentOverride(target.assessment ?? unknownAssessment(current.scanFingerprint ?? "", timestamp), override)
        } : {})
      };
      const nodes = current.nodes.map((node) => node.id === target.id ? rebound : node);
      const manualPositions = { ...(current.layout?.manualPositions ?? {}) };
      if (x !== undefined && y !== undefined) manualPositions[target.id] = { x, y };
      if (orphan.node.id !== target.id) delete manualPositions[orphan.node.id];
      nextCanvas = {
        ...current,
        nodes,
        layout: current.layout ? { ...current.layout, manualPositions } : current.layout,
        orphanedNodeEdits: orphanedNodeEdits.filter((item) => item !== orphan)
      };
      await validateReboundModuleFiles(projectPath, nextCanvas);
      decision = { ...decision, targetNodeId: target.id };
    } else if (request.action === "discard") {
      nextCanvas = { ...current, orphanedNodeEdits: orphanedNodeEdits.filter((item) => item !== orphan) };
    }
  } else if (request.item.kind === "edge") {
    const orphanedEdges = current.orphanedEdges ?? [];
    const matches = orphanedEdges.filter((edge) => edge.id === request.item.id);
    if (matches.length !== 1) throw new Error(`Canvas migration review relationship is missing or ambiguous: project ${projectPath}, item ${request.item.id}`);
    const orphan = matches[0];
    if (request.action === "rebind") {
      if (!request.sourceNodeId || !request.targetNodeId || request.sourceNodeId === request.targetNodeId) {
        throw new Error(`Canvas migration relationship rebind requires two different current endpoint IDs: item ${request.item.id}`);
      }
      const nodeIds = new Set(current.nodes.map((node) => node.id));
      if (!nodeIds.has(request.sourceNodeId) || !nodeIds.has(request.targetNodeId)) {
        throw new Error(`Canvas migration relationship rebind endpoint is not present in the current graph: item ${request.item.id}, source ${request.sourceNodeId}, target ${request.targetNodeId}`);
      }
      if (current.edges.some((edge) => edge.id === orphan.id)) {
        throw new Error(`Canvas migration relationship rebind conflicts with a current relation ID: ${orphan.id}`);
      }
      const rebound = {
        id: orphan.id,
        source: request.sourceNodeId,
        target: request.targetNodeId,
        relation: orphan.relation,
        ...(orphan.guidanceNote ? { guidanceNote: orphan.guidanceNote } : {}),
        origin: "manual" as const
      };
      nextCanvas = {
        ...current,
        edges: [...current.edges, rebound],
        orphanedEdges: orphanedEdges.filter((edge) => edge !== orphan)
      };
      decision = { ...decision, sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId };
    } else if (request.action === "discard") {
      nextCanvas = { ...current, orphanedEdges: orphanedEdges.filter((edge) => edge !== orphan) };
    }
  } else {
    const migrationPendingItems = current.migrationPendingItems ?? [];
    const matches = migrationPendingItems.filter((item) => canvasMigrationPendingItemId(item) === request.item.id);
    if (matches.length !== 1) {
      throw new Error(`Canvas migration pending record is missing or ambiguous: project ${projectPath}, item ${request.item.id}`);
    }
    if (request.action === "rebind") {
      throw new Error(`Canvas migration pending record has no verified mapping and cannot be rebound safely: ${request.item.id}`);
    }
    nextCanvas = {
      ...current,
      migrationPendingItems: request.action === "discard"
        ? migrationPendingItems.filter((item) => item !== matches[0])
        : migrationPendingItems
    };
  }

  const nextState = request.action === "rebind"
    ? createCanvasUserState(
      canvasFromGraphOverview(await readRequiredOverview(projectPath), emptyCanvasUserState(manifest.generationId), projectPath,
        { requestId: manifest.generationId, inputFingerprint: manifest.inputFingerprint }),
      nextCanvas,
      manifest.generationId,
      nextRevision
    )
    : { ...state, revision: nextRevision, updatedAt: timestamp,
      orphanedEdges: nextCanvas.orphanedEdges ?? [], orphanedNodeEdits: nextCanvas.orphanedNodeEdits ?? [],
      migrationPendingItems: nextCanvas.migrationPendingItems ?? [] };
  nextState.migrationReviewActions = [...(state.migrationReviewActions ?? []), decision];
  const stateContent = jsonText(nextState);
  const nextManifest: ProjectGenerationManifestV7 = {
    ...manifest,
    artifacts: { ...manifest.artifacts, canvasUserState: contentHash(stateContent) }
  };
  const userStatePath = join(projectPath, FLOWWEAVE_DIR, "canvas", "user-state.json");
  await writeBatchAtomic(projectPath, [
    { path: userStatePath, content: stateContent },
    { path: join(projectPath, FLOWWEAVE_DIR, "generation.json"), content: jsonText(nextManifest) }
  ]);
  return { path: userStatePath, generationId: manifest.generationId, userRevision: nextRevision };
}

async function readProtocolUserState(projectPath: string, generationId: string): Promise<CanvasUserStateV1 | undefined> {
  const manifest = await readProjectGenerationManifest(projectPath);
  if (!manifest || manifest.generationId !== generationId) return undefined;
  const path = join(projectPath, FLOWWEAVE_DIR, "canvas", "user-state.json");
  const content = await readVerifiedArtifact(path, manifest.artifacts.canvasUserState);
  const state = parseJson<CanvasUserStateV1>(content, path);
  if (state.schemaVersion !== 1 || state.generationId !== generationId || !Number.isInteger(state.revision) || state.revision < 0) {
    throw new Error(`FlowWeave committed user state is invalid: ${path}`);
  }
  return state;
}

export async function readProjectProtocolUserRevision(projectPath: string, generationId: string): Promise<number | undefined> {
  return (await readProtocolUserState(projectPath, generationId))?.revision;
}

function emptyCanvasUserState(generationId: string): CanvasUserStateV1 {
  return {
    schemaVersion: 1, generationId, revision: 0, updatedAt: "",
    nodeEdits: {}, edgeEdits: {}, manualNodes: [], manualEdges: [], orphanedEdges: [],
    orphanedNodeEdits: [], migrationReviewActions: [], migrationPendingItems: []
  };
}

async function readRequiredOverview(projectPath: string): Promise<GraphOverviewV1> {
  const overview = await readProjectProtocolOverview(projectPath);
  if (!overview) throw new Error(`Canvas migration review rejected because the committed graph overview is missing: project ${projectPath}`);
  return overview;
}

async function validateReboundModuleFiles(projectPath: string, canvas: CodeflowCanvas): Promise<void> {
  const snapshot = await readProjectProtocolSnapshot(projectPath);
  if (!snapshot) throw new Error(`Canvas migration node edit rebind rejected because the static snapshot is missing: project ${projectPath}`);
  const knownFiles = new Set(snapshot.semanticIndex.files.map((file) => file.path));
  const fileOwners = new Map<string, string>();
  for (const node of canvas.nodes) {
    if (node.origin === "manual" || node.kind !== "module") continue;
    for (const file of node.files) {
      if (!knownFiles.has(file)) {
        throw new Error(`Canvas migration node edit rebind rejected because module ${node.id} contains unknown source file ${file}: project ${projectPath}`);
      }
      const owner = fileOwners.get(file);
      if (owner && owner !== node.id) {
        throw new Error(`Canvas migration node edit rebind rejected because source file ${file} belongs to multiple generated modules (${owner}, ${node.id}): project ${projectPath}`);
      }
      fileOwners.set(file, node.id);
    }
  }
}

async function readVerifiedArtifact(path: string, expectedHash: string): Promise<string> {
  const content = await readFile(path, "utf8");
  if (contentHash(content) !== expectedHash) throw new Error(`FlowWeave committed artifact hash mismatch: ${path}`);
  return content;
}

function parseJson<T>(content: string, path: string): T {
  try { return JSON.parse(content) as T; }
  catch (error) { throw new Error(`FlowWeave committed artifact is malformed and was preserved: ${path}`, { cause: error }); }
}

export async function assertCanvasCanStartGeneration(projectPath: string, requestId: string): Promise<void> {
  const canonicalPath = await realpath(projectPath);
  await recoverArtifactTransaction(canonicalPath);
  try {
    if (await readProjectProtocolCanvas(canonicalPath)) return;
  } catch (error) {
    const path = join(canonicalPath, FLOWWEAVE_DIR, "generation.json");
    const failure = `Generation preflight failed: ${path}: ${String(error)}`;
    const record = await recordBlockedCanvasMigration(canonicalPath, path, undefined, "invalid-generation-marker", failure, "failed", requestId);
    throw new Error(`${failure}; original artifacts were preserved and backed up at ${record.backupPath}`, { cause: error });
  }
  const canvasPath = join(canonicalPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  await assertSafeProjectWritePath(canonicalPath, canvasPath);
  const canvas = await readExistingCanvas(canvasPath, canonicalPath, requestId);
  if (!canvas) {
    const inventory = await migrationInventory(join(canonicalPath, FLOWWEAVE_DIR));
    if (inventory.length > 0) {
      const failure = `Cannot migrate unknown legacy artifacts without a supported Canvas: ${canonicalPath}`;
      const record = await recordBlockedCanvasMigration(canonicalPath, canvasPath, undefined, "unknown-legacy-artifacts", failure, "failed", requestId);
      throw new Error(`${failure}; original artifacts were preserved and backed up at ${record.backupPath}`);
    }
    return;
  }
  let unrecognizedLegacyArtifact: string | undefined;
  let legacyArtifactReadError: unknown;
  for (const [artifactPath, isSupported] of legacyMigrationArtifacts) {
    const path = join(canonicalPath, FLOWWEAVE_DIR, artifactPath);
    if (!await pathExists(path)) continue;
    await assertSafeProjectWritePath(canonicalPath, path);
    let value: unknown;
    try {
      value = await readJsonArtifact(path);
    } catch (error) {
      unrecognizedLegacyArtifact = artifactPath;
      legacyArtifactReadError = error;
      break;
    }
    if (!isSupported(value)) {
      unrecognizedLegacyArtifact = artifactPath;
      break;
    }
  }
  if (unrecognizedLegacyArtifact) {
    const readFailure = legacyArtifactReadError ? `: ${String(legacyArtifactReadError)}` : "";
    const failure = `Legacy Canvas coexists with unrecognized legacy artifact ${unrecognizedLegacyArtifact}${readFailure}: ${canonicalPath}`;
    const sourceVersion = "version" in canvas ? canvas.version : undefined;
    const record = await recordBlockedCanvasMigration(canonicalPath, join(canonicalPath, FLOWWEAVE_DIR, unrecognizedLegacyArtifact), sourceVersion,
      "unrecognized-legacy-artifact", failure, "failed", requestId);
    throw new Error(`${failure}; original artifacts were preserved and backed up at ${record.backupPath}`, { cause: legacyArtifactReadError });
  }
  let unrecognizedProtocolArtifact: string | undefined;
  for (const artifactPath of protocolV7ArtifactPaths) {
    if (await pathExists(join(canonicalPath, FLOWWEAVE_DIR, artifactPath))) {
      unrecognizedProtocolArtifact = artifactPath;
      break;
    }
  }
  if (unrecognizedProtocolArtifact) {
    const failure = `Legacy Canvas coexists with unrecognized protocol artifact ${unrecognizedProtocolArtifact}: ${canonicalPath}`;
    const sourceVersion = "version" in canvas ? canvas.version : undefined;
    const record = await recordBlockedCanvasMigration(canonicalPath, canvasPath, sourceVersion,
      "unrecognized-protocol-artifact", failure, "failed", requestId);
    throw new Error(`${failure}; original artifacts were preserved and backed up at ${record.backupPath}`);
  }
  await recordBlockedCanvasMigration(canonicalPath, canvasPath, "version" in canvas ? canvas.version : undefined, "legacy-canvas-version", "Legacy user data was archived before conversion.", "in-progress", requestId);
}

export async function recordCanvasMigrationFailure(projectPath: string, requestId: string, error: unknown): Promise<void> {
  const canonicalPath = await realpath(projectPath);
  const recordPath = join(canonicalPath, FLOWWEAVE_DIR, "migration", "record.json");
  const record = await readMigrationRecord(recordPath);
  if (!record || record.status !== "in-progress" || record.requestId !== requestId) return;
  record.status = "failed";
  record.failure = {
    code: "migration-generation-failed",
    stage: "analysis",
    artifactPath: "canvas/main.canvas.json",
    message: error instanceof Error ? error.message : String(error)
  };
  await writeMigrationRecord(canonicalPath, recordPath, record);
}

export async function readCanvasForGeneration(projectPath: string): Promise<CanvasForGeneration | undefined> {
  const canonicalPath = await realpath(projectPath);
  await recoverArtifactTransaction(canonicalPath);
  const currentCanvas = await readProjectProtocolCanvas(canonicalPath);
  if (currentCanvas) return currentCanvas;
  const canvasPath = join(canonicalPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  await assertSafeProjectWritePath(canonicalPath, canvasPath);
  return readExistingCanvas(canvasPath, canonicalPath, undefined);
}

async function readExistingCanvas(path: string, projectPath: string, requestId: string | undefined): Promise<CanvasForGeneration | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${path}`, { cause: error });
  }

  let canvas: unknown;
  try {
    canvas = JSON.parse(content) as unknown;
  } catch (error) {
    const failure = `Canvas JSON is malformed: ${path}`;
    const record = await recordBlockedCanvasMigration(projectPath, path, undefined, "malformed-json", failure, "failed", requestId);
    throw new Error(`${failure}; Canvas was preserved and original artifacts are backed up at ${record.backupPath}`, { cause: error });
  }
  if (!isRecord(canvas)) {
    const failure = `FlowWeave Canvas must be an object: ${path}`;
    const record = await recordBlockedCanvasMigration(projectPath, path, undefined, "invalid-legacy-canvas", failure, "failed", requestId);
    throw new Error(`${failure}; Canvas was preserved and original artifacts are backed up at ${record.backupPath}`);
  }
  const version = canvas.version;
  if (version === 1 || version === 2 || version === 3 || version === 4) {
    if (!validLegacyGraphArrays(canvas.nodes, canvas.edges)) {
      const failure = `Canvas v${version} has invalid node or edge data: ${path}`;
      const record = await recordBlockedCanvasMigration(projectPath, path, version, "invalid-legacy-canvas", failure, "failed", requestId);
      throw new Error(`${failure}; Canvas was preserved and original artifacts are backed up at ${record.backupPath}`);
    }
    return {
      version,
      nodes: [],
      edges: [],
      rawNodes: canvas.nodes as unknown[],
      rawEdges: canvas.edges as unknown[],
      layout: normalizeLegacyLayout((canvas as { layout?: unknown }).layout)
    };
  }
  if ((canvas.version === 5 || canvas.version === 6) && validLegacyGraphArrays(canvas.nodes, canvas.edges) &&
    (canvas.nodes as unknown[]).every((node, index) => !graphNodeShapeIssue(node, `nodes[${index}]`)) &&
    (canvas.edges as unknown[]).every((edge, index) => !graphEdgeShapeIssue(edge, `edges[${index}]`))) {
    return canvas as unknown as StoredCanvas;
  }
  const failure = `FlowWeave Canvas is not a valid v6 artifact: ${path}`;
  const record = await recordBlockedCanvasMigration(projectPath, path, typeof version === "number" ? version : undefined, "unsupported-canvas", failure, "failed", requestId);
  throw new Error(`${failure}; Canvas was preserved and original artifacts are backed up at ${record.backupPath}`);
}

function validLegacyGraphArrays(nodes: unknown, edges: unknown): boolean {
  return Array.isArray(nodes) && Array.isArray(edges) &&
    nodes.every((node) => isRecord(node) && typeof node.id === "string" && node.id.length > 0) &&
    edges.every((edge) => isRecord(edge) && typeof edge.id === "string" && edge.id.length > 0 &&
      typeof edge.source === "string" && typeof edge.target === "string");
}

function normalizeLegacyLayout(value: unknown): CanvasLayoutState | undefined {
  if (!isRecord(value)) return undefined;
  const viewMode = value.viewMode === "dependency" || value.activeMode === "dependency" ? "dependency" : "execution";
  const autoLayouts = normalizeLayoutPositions(value.autoLayouts);
  const autoConnectionHandles = normalizeAutoConnectionHandles(value.autoConnectionHandles);
  const rawTopologyFingerprints = value.autoLayoutTopologyFingerprints;
  const topologyFingerprints = isRecord(rawTopologyFingerprints)
    ? Object.fromEntries(["execution", "dependency"].flatMap((mode) => {
        const fingerprint = rawTopologyFingerprints[mode];
        return typeof fingerprint === "string" ? [[mode, fingerprint]] : [];
      }))
    : {};
  const collapsedGroups = Array.isArray(value.collapsedGroups)
    ? [...new Set(value.collapsedGroups.filter((group): group is string => typeof group === "string")
        .map((group) => group.startsWith("domain:") ? `area:${group.slice("domain:".length)}` : group)
        .filter((group) => group.startsWith("area:") || group.startsWith("group:")))].sort()
    : [];
  return {
    activeMode: value.activeMode === "manual" ? "manual" : viewMode,
    viewMode,
    manualPositions: normalizePositions(value.manualPositions),
    autoLayouts,
    ...(Object.keys(autoConnectionHandles).length > 0 ? { autoConnectionHandles } : {}),
    ...(Object.keys(topologyFingerprints).length > 0 ? { autoLayoutTopologyFingerprints: topologyFingerprints } : {}),
    collapsedGroups
  };
}

function normalizeLayoutPositions(value: unknown): Partial<CanvasLayoutState["autoLayouts"]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(["execution", "dependency"].flatMap((mode) => {
    const positions = value[mode];
    return isRecord(positions) ? [[mode, normalizePositions(positions)]] : [];
  }));
}

function normalizeAutoConnectionHandles(value: unknown): NonNullable<CanvasLayoutState["autoConnectionHandles"]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries((["execution", "dependency"] as const).flatMap((mode) => {
    const layout = value[mode];
    if (!isRecord(layout) || !isRecord(layout.handles)) return [];
    const handles = Object.fromEntries(Object.entries(layout.handles).flatMap(([nodeId, nodeLayout]) => {
      if (!isRecord(nodeLayout) || !Array.isArray(nodeLayout.source) || !Array.isArray(nodeLayout.target)) return [];
      return [[nodeId, {
        source: normalizeHandleSlots(nodeLayout.source),
        target: normalizeHandleSlots(nodeLayout.target)
      } satisfies ConnectionHandleLayout]];
    }));
    return [[mode, {
      positions: normalizePositions(layout.positions),
      handles,
      ...(typeof layout.topologyFingerprint === "string" ? { topologyFingerprint: layout.topologyFingerprint } : {})
    }]];
  }));
}

function normalizeHandleSlots(value: unknown[]): ConnectionHandleSlot[] {
  const positions = ["left", "right", "top", "bottom"] as const;
  const relations: GraphEdgeRelation[] = ["depends_on", "calls", "reads", "writes", "reads_writes", "http_contract", "process_invocation", "external_api", "publishes_event", "subscribes_event", "tests"];
  return value.flatMap((slot) => {
    if (!isRecord(slot) || typeof slot.id !== "string" || typeof slot.offsetPercent !== "number" ||
      !Number.isFinite(slot.offsetPercent) || slot.offsetPercent < 0 || slot.offsetPercent > 100 ||
      typeof slot.count !== "number" || !Number.isInteger(slot.count) || slot.count < 0 ||
      (slot.edgeId !== undefined && typeof slot.edgeId !== "string") ||
      (slot.position !== undefined && !positions.includes(slot.position as typeof positions[number])) ||
      (slot.collapsed !== undefined && typeof slot.collapsed !== "boolean") ||
      (slot.relation !== undefined && !relations.includes(slot.relation as GraphEdgeRelation))) return [];
    return [{
      id: slot.id,
      ...(typeof slot.edgeId === "string" ? { edgeId: slot.edgeId } : {}),
      ...(positions.includes(slot.position as typeof positions[number]) ? { position: slot.position as ConnectionHandleSlot["position"] } : {}),
      offsetPercent: slot.offsetPercent,
      count: slot.count,
      ...(typeof slot.collapsed === "boolean" ? { collapsed: slot.collapsed } : {}),
      ...(typeof slot.relation === "string" ? { relation: slot.relation as GraphEdgeRelation } : {})
    }];
  });
}

function normalizePositions(value: unknown): CanvasLayoutState["manualPositions"] {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, position]) => {
    if (!isRecord(position) || typeof position.x !== "number" || !Number.isFinite(position.x) ||
      typeof position.y !== "number" || !Number.isFinite(position.y)) return [];
    return [[id, { x: position.x, y: position.y }]];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedLegacyProjectArtifact(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyFields(value, ["version", "projectName", "rootPath", "generatedAt", "git", "summary", "files", "generatorVersion", "inputFingerprint", "scanFingerprint", "artifactState", "generation", "scanDelta"]) ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.projectName !== "string" || typeof value.rootPath !== "string" || typeof value.generatedAt !== "string" ||
    !isRecord(value.git) || !hasOnlyFields(value.git, ["isRepo", "branch", "remote", "status"]) || typeof value.git.isRepo !== "boolean" ||
    !isOptionalString(value.git, "branch") || !isOptionalString(value.git, "remote") || !isOptionalString(value.git, "status") ||
    !isRecord(value.summary) || !hasOnlyFields(value.summary, ["totalFiles", "totalFolders", "displayedEntries", "truncated", "languages"]) ||
    !isNonNegativeInteger(value.summary.totalFiles) || !isNonNegativeInteger(value.summary.totalFolders) ||
    !isRecord(value.summary.languages) || !Object.values(value.summary.languages).every(isNonNegativeInteger) ||
    !isOptionalNonNegativeInteger(value.summary, "displayedEntries") ||
    (value.summary.truncated !== undefined && typeof value.summary.truncated !== "boolean") ||
    !Array.isArray(value.files)) return false;
  return value.files.every(isSupportedProjectFileNode) && isOptionalString(value, "generatorVersion") &&
    isOptionalString(value, "inputFingerprint") && isOptionalString(value, "scanFingerprint") &&
    (value.artifactState === undefined || ["current", "stale", "missing", "failed"].includes(String(value.artifactState))) &&
    (value.generation === undefined || isGenerationIdentity(value.generation)) &&
    (value.scanDelta === undefined || isSupportedScanDelta(value.scanDelta));
}

function isSupportedLegacyArchitectureArtifact(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyFields(value, ["version", "projectName", "rootPath", "generatedAt", "source", "modules", "relationships", "files", "symbols", "generatorVersion", "generation", "resources", "groups", "quality", "relationDiagnostics", "metadata", "architectureStyle", "reviewFindings", "moduleDiagnostics"]) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3)) return false;
  const version = value.version;
  if (version < 3 && hasAnyFields(value, ["generatorVersion", "generation", "resources", "groups", "quality", "relationDiagnostics"])) return false;
  return typeof value.projectName === "string" && typeof value.rootPath === "string" && typeof value.generatedAt === "string" &&
    (value.source === "agent" || value.source === "local") && Array.isArray(value.modules) && value.modules.every((module) => isSupportedArchitectureModule(module, version)) &&
    Array.isArray(value.relationships) && value.relationships.every((relationship) => isSupportedArchitectureRelationship(relationship, version)) &&
    Array.isArray(value.files) && value.files.every((file) => isSupportedFileInsight(file, version)) &&
    Array.isArray(value.symbols) && value.symbols.every((symbol) => isSupportedStructureSymbol(symbol, version)) &&
    isOptionalString(value, "generatorVersion") && isOptionalString(value, "architectureStyle") &&
    (value.generation === undefined || isGenerationIdentity(value.generation)) &&
    (value.metadata === undefined || isSupportedArtifactGenerationMetadata(value.metadata)) &&
    (value.resources === undefined || (Array.isArray(value.resources) && value.resources.every((resource) => isSupportedSemanticResource(resource, version)))) &&
    (value.groups === undefined || (Array.isArray(value.groups) && value.groups.every(isSupportedArchitectureGroup))) &&
    (value.quality === undefined || isSupportedStaticAnalysisQuality(value.quality)) &&
    (value.reviewFindings === undefined || (Array.isArray(value.reviewFindings) && value.reviewFindings.every(isSupportedReviewFinding))) &&
    (value.moduleDiagnostics === undefined || (Array.isArray(value.moduleDiagnostics) && value.moduleDiagnostics.every((diagnostic) => isSupportedModuleDiagnostic(diagnostic, version)))) &&
    (value.relationDiagnostics === undefined || (Array.isArray(value.relationDiagnostics) && value.relationDiagnostics.every(isSupportedRelationDiagnostic)));
}

function isSupportedLegacyLocalArchitectureArtifact(value: unknown): boolean {
  return isSupportedLegacyArchitectureArtifact(value) && isRecord(value) && value.source === "local";
}

function isSupportedProjectFileNode(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyFields(value, ["id", "name", "path", "type", "depth", "language", "size", "modifiedAt", "children"]) ||
    typeof value.id !== "string" || typeof value.name !== "string" || typeof value.path !== "string" ||
    (value.type !== "folder" && value.type !== "file") || !isNonNegativeInteger(value.depth) ||
    (value.language !== undefined && typeof value.language !== "string") ||
    (value.size !== undefined && (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0)) ||
    (value.modifiedAt !== undefined && typeof value.modifiedAt !== "string")) return false;
  return value.children === undefined || (Array.isArray(value.children) && value.children.every(isSupportedProjectFileNode));
}

function isSupportedArchitectureModule(value: unknown, version: 1 | 2 | 3): boolean {
  const categories = ["api-boundary", "domain-service", "data-access", "external-integration", "job-worker", "shared-utility", "test-surface", "unknown"];
  const nodeTypes = ["module", "entrypoint", "api", "service", "data", "external", "worker", "utility", "test"];
  const risks = ["low", "medium", "high", "unknown"];
  if (!isRecord(value) || !hasOnlyFields(value, ["id", "identity", "title", "category", "nodeType", "role", "description", "files", "fileRoles", "symbols", "evidence", "risk", "relationSummary", "relationDiagnostics", "groupPath", "confidence", "assessment", "assessmentNotes"]) ||
    (version < 3 && hasAnyFields(value, ["relationSummary", "relationDiagnostics", "groupPath"])) ||
    typeof value.id !== "string" || typeof value.title !== "string" ||
    !categories.includes(String(value.category)) || !nodeTypes.includes(String(value.nodeType)) ||
    typeof value.role !== "string" || typeof value.description !== "string" ||
    !isStringArray(value.files) || !Array.isArray(value.fileRoles) || !value.fileRoles.every((fileRole) =>
      isRecord(fileRole) && hasOnlyFields(fileRole, ["path", "role"]) && typeof fileRole.path === "string" && typeof fileRole.role === "string") ||
    !Array.isArray(value.symbols) || !value.symbols.every((symbol) => isSupportedStructureSymbol(symbol, version)) ||
    !Array.isArray(value.evidence) || !value.evidence.every((evidence) => isSupportedArchitectureEvidence(evidence, version)) ||
    !risks.includes(String(value.risk))) return false;
  if (value.identity !== undefined && (!isRecord(value.identity) || !hasOnlyFields(value.identity, ["id", "anchor", "clusterFingerprint", "predecessorIds"]) || typeof value.identity.id !== "string" ||
    typeof value.identity.anchor !== "string" || typeof value.identity.clusterFingerprint !== "string" ||
    !isStringArray(value.identity.predecessorIds))) return false;
  return (value.relationSummary === undefined || (isRecord(value.relationSummary) && hasOnlyFields(value.relationSummary, ["dependencies", "internalRelations", "unresolvedRelations", "externalRelations"]) &&
      isNonNegativeInteger(value.relationSummary.dependencies) && isNonNegativeInteger(value.relationSummary.internalRelations) &&
      isNonNegativeInteger(value.relationSummary.unresolvedRelations) && isNonNegativeInteger(value.relationSummary.externalRelations))) &&
    (value.relationDiagnostics === undefined || (Array.isArray(value.relationDiagnostics) && value.relationDiagnostics.every((diagnostic) => isSupportedSemanticDiagnostic(diagnostic, version)))) &&
    (value.groupPath === undefined || (Array.isArray(value.groupPath) && value.groupPath.every(isSupportedGroupReference))) &&
    (value.confidence === undefined || isUnitInterval(value.confidence)) &&
    (value.assessment === undefined || isSupportedModuleAssessment(value.assessment, version)) &&
    isOptionalString(value, "assessmentNotes");
}

function isSupportedArchitectureRelationship(value: unknown, version: 1 | 2 | 3): boolean {
  const relations = ["depends_on", "calls", "reads", "writes", "reads_writes", "http_contract", "process_invocation", "external_api", "publishes_event", "subscribes_event", "tests"];
  const kinds = ["import", "call", "inherit", "render", "http", "database", "filesystem", "process", "event", "test"];
  const operations = ["read", "write", "publish", "subscribe", "invoke"];
  const importUsages = ["value", "type", "side-effect", "inherit"];
  return isRecord(value) && hasOnlyFields(value, ["id", "source", "target", "relation", "description", "evidence", "semanticKinds", "operations", "importUsages", "sourceRelationIds", "confidence"]) &&
    !(version < 3 && hasAnyFields(value, ["semanticKinds", "operations", "importUsages", "sourceRelationIds", "confidence"])) &&
    typeof value.id === "string" && typeof value.source === "string" && typeof value.target === "string" &&
    relations.includes(String(value.relation)) && typeof value.description === "string" &&
    Array.isArray(value.evidence) && value.evidence.every((evidence) => isSupportedArchitectureEvidence(evidence, version)) &&
    (value.semanticKinds === undefined || isStringArray(value.semanticKinds) && value.semanticKinds.every((kind) => kinds.includes(kind))) &&
    (value.operations === undefined || isStringArray(value.operations) && value.operations.every((operation) => operations.includes(operation))) &&
    (value.importUsages === undefined || isStringArray(value.importUsages) && value.importUsages.every((usage) => importUsages.includes(usage))) &&
    (value.sourceRelationIds === undefined || isStringArray(value.sourceRelationIds)) &&
    (value.confidence === undefined || value.confidence === "confirmed" || value.confidence === "inferred");
}

function isSupportedFileInsight(value: unknown, version: 1 | 2 | 3): boolean {
  return isRecord(value) && hasOnlyFields(value, ["path", "language", "imports", "exports", "symbols", "calls", "externalCalls", "role", "moduleId"]) &&
    typeof value.path === "string" && isStringArray(value.imports) && isStringArray(value.exports) &&
    Array.isArray(value.symbols) && value.symbols.every((symbol) => isSupportedStructureSymbol(symbol, version)) && isStringArray(value.calls) &&
    Array.isArray(value.externalCalls) && value.externalCalls.every(isSupportedExternalCallInsight) &&
    (value.language === undefined || typeof value.language === "string") &&
    (value.role === undefined || typeof value.role === "string") &&
    (value.moduleId === undefined || typeof value.moduleId === "string");
}

function isSupportedStructureSymbol(value: unknown, version: 1 | 2 | 3): boolean {
  const kinds = ["function", "class", "method", "export", "variable"];
  return isRecord(value) && hasOnlyFields(value, ["id", "qualifiedName", "scopeId", "range", "name", "kind", "filePath", "role", "exported", "line", "signature"]) &&
    !(version < 3 && hasAnyFields(value, ["id", "qualifiedName", "scopeId", "range"])) &&
    typeof value.name === "string" && kinds.includes(String(value.kind)) && typeof value.filePath === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.qualifiedName === undefined || typeof value.qualifiedName === "string") &&
    (value.scopeId === undefined || typeof value.scopeId === "string") &&
    (value.role === undefined || typeof value.role === "string") &&
    (value.exported === undefined || typeof value.exported === "boolean") &&
    (value.line === undefined || isPositiveInteger(value.line)) &&
    (value.signature === undefined || typeof value.signature === "string") &&
    (value.range === undefined || isSourceRange(value.range));
}

function isSupportedArchitectureEvidence(value: unknown, version: 1 | 2 | 3): boolean {
  const operations = ["read", "write", "publish", "subscribe", "invoke"];
  return isRecord(value) && hasOnlyFields(value, ["operation", "role", "relationId", "range", "declarationRange", "bindingBasis", "filePath", "symbol", "line", "eventId", "detail"]) &&
    !(version < 3 && hasAnyFields(value, ["operation", "role", "relationId", "range", "declarationRange", "bindingBasis"])) &&
    typeof value.detail === "string" &&
    (value.operation === undefined || operations.includes(String(value.operation))) &&
    (value.role === undefined || value.role === "source" || value.role === "target") &&
    isOptionalString(value, "relationId") && isOptionalString(value, "bindingBasis") &&
    isOptionalString(value, "filePath") && isOptionalString(value, "symbol") && isOptionalString(value, "eventId") &&
    (value.line === undefined || isPositiveInteger(value.line)) &&
    (value.range === undefined || isSourceRange(value.range)) &&
    (value.declarationRange === undefined || isSourceRange(value.declarationRange));
}

function isSupportedExternalCallInsight(value: unknown): boolean {
  const kinds = ["http", "database", "filesystem", "process", "queue", "unknown"];
  return isRecord(value) && hasOnlyFields(value, ["kind", "target", "filePath", "symbol"]) && kinds.includes(String(value.kind)) && typeof value.target === "string" &&
    typeof value.filePath === "string" && (value.symbol === undefined || typeof value.symbol === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isOptionalNonNegativeInteger(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || isNonNegativeInteger(value[key]);
}

function isGenerationIdentity(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["requestId", "inputFingerprint"]) && typeof value.requestId === "string" && typeof value.inputFingerprint === "string";
}

function isSupportedScanDelta(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["added", "modified", "deleted", "unchanged"]) && isStringArray(value.added) && isStringArray(value.modified) &&
    isStringArray(value.deleted) && isStringArray(value.unchanged);
}

function isSourceRange(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["start", "end"]) && isSourcePosition(value.start) && isSourcePosition(value.end);
}

function isSourcePosition(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["line", "column"]) && isPositiveInteger(value.line) && isPositiveInteger(value.column);
}

function isUnitInterval(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSupportedSemanticDiagnostic(value: unknown, version: 1 | 2 | 3): boolean {
  const stages = ["parsing", "binding"];
  return isRecord(value) && hasOnlyFields(value, ["code", "severity", "message", "filePath", "relationId", "range", "candidates", "stage"]) &&
    !(version < 3 && hasAnyFields(value, ["relationId", "range", "candidates", "stage"])) &&
    typeof value.code === "string" &&
    (value.severity === "warning" || value.severity === "error") && typeof value.message === "string" &&
    typeof value.filePath === "string" && isOptionalString(value, "relationId") &&
    (value.range === undefined || isSourceRange(value.range)) &&
    (value.candidates === undefined || isStringArray(value.candidates)) &&
    (value.stage === undefined || stages.includes(String(value.stage)));
}

function isSupportedGroupReference(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["id", "title", "rootPath", "parentId", "titleSources"]) && isSupportedGroupReferenceFields(value);
}

function isSupportedArchitectureGroup(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["id", "title", "rootPath", "parentId", "titleSources", "moduleIds"]) &&
    isSupportedGroupReferenceFields(value) && isStringArray(value.moduleIds);
}

function isSupportedGroupReferenceFields(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && typeof value.title === "string" && typeof value.rootPath === "string" &&
    isOptionalString(value, "parentId") && (value.titleSources === undefined || isStringArray(value.titleSources));
}

function isSupportedArtifactGenerationMetadata(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["generatedAt", "inputFingerprint", "fileCoverage", "evidenceCoverage", "source", "agentId", "runId", "reviewId", "scanFingerprint"]) &&
    typeof value.generatedAt === "string" && typeof value.inputFingerprint === "string" &&
    typeof value.fileCoverage === "number" && Number.isFinite(value.fileCoverage) &&
    typeof value.evidenceCoverage === "number" && Number.isFinite(value.evidenceCoverage) &&
    (value.source === undefined || value.source === "agent" || value.source === "local") &&
    isOptionalString(value, "agentId") && isOptionalString(value, "runId") && isOptionalString(value, "reviewId") &&
    isOptionalString(value, "scanFingerprint");
}

function isSupportedSemanticResource(value: unknown, version: 1 | 2 | 3): boolean {
  const kinds = ["api", "database", "filesystem", "event", "process", "package"];
  return isRecord(value) && hasOnlyFields(value, ["id", "kind", "scopeId", "key", "title", "detail", "evidence"]) && typeof value.id === "string" && kinds.includes(String(value.kind)) &&
    typeof value.scopeId === "string" && typeof value.key === "string" && typeof value.title === "string" &&
    typeof value.detail === "string" && Array.isArray(value.evidence) && value.evidence.every((evidence) => isSupportedArchitectureEvidence(evidence, version));
}

function isSupportedStaticAnalysisQuality(value: unknown): boolean {
  const counts = ["eligibleFiles", "parsedFiles", "failedFiles", "unsupportedFiles", "internalImports", "resolvedInternalImports",
    "unresolvedInternalImports", "calls", "resolvedCalls", "ambiguousCalls"];
  return isRecord(value) && hasOnlyFields(value, [...counts, "complete", "factOutcomes"]) && counts.every((key) => isNonNegativeInteger(value[key])) && typeof value.complete === "boolean" &&
    (value.factOutcomes === undefined || Array.isArray(value.factOutcomes) && value.factOutcomes.every(isSupportedSemanticFactOutcome));
}

function isSupportedSemanticFactOutcome(value: unknown): boolean {
  const kinds = ["import", "call", "inherit", "render", "http", "database", "filesystem", "process", "event", "test"];
  const outcomes = ["architecture-edge", "module-internal", "external", "ambiguous", "unresolved", "unsupported"];
  return isRecord(value) && hasOnlyFields(value, ["kind", "outcome", "count", "relationIds"]) && kinds.includes(String(value.kind)) && outcomes.includes(String(value.outcome)) &&
    isNonNegativeInteger(value.count) && isStringArray(value.relationIds);
}

function isSupportedReviewFinding(value: unknown): boolean {
  return isRecord(value) && hasOnlyFields(value, ["code", "severity", "moduleIds", "message", "evidenceIds"]) && typeof value.code === "string" &&
    (value.severity === "warning" || value.severity === "error") && isStringArray(value.moduleIds) &&
    typeof value.message === "string" && isStringArray(value.evidenceIds);
}

function isSupportedModuleDiagnostic(value: unknown, version: 1 | 2 | 3): boolean {
  const codes = ["unknown-files", "oversized-module", "lineage-split", "lineage-merge", "ambiguous-ownership", "mixed-role-signals"];
  const categories = ["api-boundary", "domain-service", "data-access", "external-integration", "job-worker", "shared-utility", "test-surface", "unknown"];
  return isRecord(value) && hasOnlyFields(value, ["code", "moduleIds", "filePaths", "message", "roleSignals"]) && !(version < 3 && (value.code === "mixed-role-signals" || value.roleSignals !== undefined)) &&
    codes.includes(String(value.code)) && isStringArray(value.moduleIds) &&
    isStringArray(value.filePaths) && typeof value.message === "string" &&
    (value.roleSignals === undefined || isStringArray(value.roleSignals) && value.roleSignals.every((category) => categories.includes(category)));
}

function isSupportedRelationDiagnostic(value: unknown): boolean {
  const kinds = ["import", "call", "inherit", "render", "http", "database", "filesystem", "process", "event", "test"];
  const reasons = ["unlocated-target", "direction-unknown", "same-module", "ambiguous-target", "unsupported", "external"];
  return isRecord(value) && hasOnlyFields(value, ["kind", "reason", "count", "relationIds"]) && kinds.includes(String(value.kind)) && reasons.includes(String(value.reason)) &&
    isNonNegativeInteger(value.count) && (value.relationIds === undefined || isStringArray(value.relationIds));
}

function hasAnyFields(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => value[key] !== undefined);
}

function hasOnlyFields(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSupportedModuleAssessment(value: unknown, version: 1 | 2 | 3): boolean {
  return isRecord(value) && hasOnlyFields(value, ["version", "generatorVersion", "confidence", "risk", "fingerprint", "assessedAt"]) && value.version === 1 && typeof value.generatorVersion === "string" &&
    isSupportedAssessmentScore(value.confidence, version) && isSupportedRiskAssessment(value.risk, version) &&
    typeof value.fingerprint === "string" && typeof value.assessedAt === "string";
}

function isSupportedAssessmentScore(value: unknown, version: 1 | 2 | 3): boolean {
  const levels = ["low", "medium", "high", "unknown"];
  return isRecord(value) && hasOnlyFields(value, ["level", "score", "factors"]) && levels.includes(String(value.level)) &&
    (value.score === undefined || (typeof value.score === "number" && Number.isFinite(value.score))) &&
    Array.isArray(value.factors) && value.factors.every((factor) => isSupportedAssessmentFactor(factor, version));
}

function isSupportedRiskAssessment(value: unknown, version: 1 | 2 | 3): boolean {
  const levels = ["low", "medium", "high", "unknown"];
  if (!isRecord(value) || !hasOnlyFields(value, ["systemScore", "systemLevel", "effectiveLevel", "previousSystemLevel", "systemLevelChanged", "factors", "override"]) ||
    !levels.includes(String(value.systemLevel)) || !levels.includes(String(value.effectiveLevel)) ||
    !Array.isArray(value.factors) || !value.factors.every((factor) => isSupportedAssessmentFactor(factor, version)) ||
    (value.systemScore !== undefined && (typeof value.systemScore !== "number" || !Number.isFinite(value.systemScore))) ||
    (value.previousSystemLevel !== undefined && !levels.includes(String(value.previousSystemLevel))) ||
    (value.systemLevelChanged !== undefined && typeof value.systemLevelChanged !== "boolean")) return false;
  if (value.override === undefined) return true;
  return isRecord(value.override) && hasOnlyFields(value.override, ["level", "reason", "createdAt", "systemLevelAtOverride"]) && ["low", "medium", "high"].includes(String(value.override.level)) &&
    typeof value.override.reason === "string" && typeof value.override.createdAt === "string" &&
    (value.override.systemLevelAtOverride === undefined || levels.includes(String(value.override.systemLevelAtOverride)));
}

function isSupportedAssessmentFactor(value: unknown, version: 1 | 2 | 3): boolean {
  return isRecord(value) && hasOnlyFields(value, ["id", "label", "score", "maxScore", "reason", "evidence"]) && typeof value.id === "string" && typeof value.label === "string" &&
    typeof value.score === "number" && Number.isFinite(value.score) &&
    typeof value.maxScore === "number" && Number.isFinite(value.maxScore) &&
    typeof value.reason === "string" && Array.isArray(value.evidence) &&
    value.evidence.every((evidence) => isSupportedArchitectureEvidence(evidence, version));
}

type MigrationInventoryEntry = { path: string; size: number; sha256: string };
type MigrationRecord = {
  version: 1;
  targetProtocol: 7;
  status: "in-progress" | "failed" | "complete";
  requestId?: string;
  sourceInventoryFingerprint: string;
  sourceCanvasVersion?: number;
  backupPath: string;
  fileCount: number;
  attemptCount: number;
  attemptedAt: string;
  completedAt?: string;
  pendingItemCount?: number;
  failure?: { code: string; stage: "backup" | "decode" | "analysis"; artifactPath: string; message: string };
};
type MigrationBackupManifest = { version: 1; sourceInventoryFingerprint: string; files: MigrationInventoryEntry[] };

async function recordBlockedCanvasMigration(
  projectPath: string,
  canvasPath: string,
  sourceCanvasVersion: number | undefined,
  code: string,
  message: string,
  status: MigrationRecord["status"],
  requestId: string | undefined
): Promise<MigrationRecord> {
  const flowweaveRoot = join(projectPath, FLOWWEAVE_DIR);
  const inventory = await migrationInventory(flowweaveRoot);
  const sourceInventoryFingerprint = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  const backupPath = join(FLOWWEAVE_DIR, "migration", "backups", sourceInventoryFingerprint);
  const backupRoot = join(projectPath, backupPath);
  const manifest: MigrationBackupManifest = { version: 1, sourceInventoryFingerprint, files: inventory };
  const recordPath = join(flowweaveRoot, "migration", "record.json");
  const previous = await readMigrationRecord(recordPath);
  const attemptCount = previous?.sourceInventoryFingerprint === sourceInventoryFingerprint ? previous.attemptCount + 1 : 1;
  const artifactPath = relative(flowweaveRoot, canvasPath).split(sep).join("/");
  const record: MigrationRecord = {
    version: 1,
    targetProtocol: 7,
    status,
    ...(requestId ? { requestId } : {}),
    sourceInventoryFingerprint,
    ...(sourceCanvasVersion === undefined ? {} : { sourceCanvasVersion }),
    backupPath,
    fileCount: inventory.length,
    attemptCount,
    attemptedAt: new Date().toISOString(),
    ...(status === "failed" ? { failure: { code: "backup-in-progress", stage: "backup" as const, artifactPath, message: "Migration backup has not yet been verified." } } : {})
  };
  await writeMigrationRecord(projectPath, recordPath, record);
  try {
    await ensureMigrationBackup(projectPath, flowweaveRoot, backupRoot, manifest);
  } catch (error) {
    record.status = "failed";
    record.failure = { code: "backup-failed", stage: "backup", artifactPath, message: String(error) };
    await writeMigrationRecord(projectPath, recordPath, record);
    throw error;
  }
  if (status === "failed") {
    record.failure = { code, stage: "decode", artifactPath, message };
    await writeMigrationRecord(projectPath, recordPath, record);
  }
  return record;
}

async function assertMigrationInventoryUnchanged(projectPath: string, requestId: string | undefined, expectedRecord: MigrationRecord | undefined): Promise<void> {
  const root = join(projectPath, FLOWWEAVE_DIR);
  const recordPath = join(root, "migration", "record.json");
  const liveRecord = await readMigrationRecord(recordPath);
  const record = expectedRecord ?? liveRecord;
  if (!record || record.status === "complete") return;
  try {
    if (!liveRecord || liveRecord.status !== "in-progress" || liveRecord.requestId !== requestId ||
      liveRecord.sourceInventoryFingerprint !== record.sourceInventoryFingerprint || liveRecord.backupPath !== record.backupPath) {
      throw new Error(`FlowWeave migration input changed because its record is missing or inactive: ${recordPath}`);
    }
    const inventory = await migrationInventory(root);
    const fingerprint = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
    if (fingerprint !== record.sourceInventoryFingerprint) {
      throw new Error(`FlowWeave migration input changed after backup: project ${projectPath}, request ${requestId}`);
    }
    const backupRoot = join(projectPath, record.backupPath);
    if (!await pathExists(backupRoot)) throw new Error(`Migration backup is missing: ${backupRoot}`);
    await ensureMigrationBackup(projectPath, root, backupRoot, {
      version: 1, sourceInventoryFingerprint: fingerprint, files: inventory
    });
  } catch (error) {
    await writeMigrationRecord(projectPath, recordPath, { ...record, status: "failed", failure: {
      code: "migration-input-changed", stage: "backup", artifactPath: ".", message: String(error)
    } });
    throw error;
  }
}

async function migrationInventory(flowweaveRoot: string): Promise<MigrationInventoryEntry[]> {
  try {
    const root = await lstat(flowweaveRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Cannot safely archive FlowWeave data root: ${flowweaveRoot}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files: MigrationInventoryEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === "migration" || relativePath === "architecture-artifact.lock" || relativePath === "generation-request.json" || isTransactionFile(relativePath)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Cannot safely archive symbolic link in FlowWeave data: ${absolutePath}`);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Cannot safely archive non-file FlowWeave data: ${absolutePath}`);
      const info = await lstat(absolutePath);
      files.push({ path: relativePath, size: info.size, sha256: await hashFile(absolutePath) });
    }
  }
  await visit(flowweaveRoot, "");
  return files;
}

function isTransactionFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return name === "transaction.json" || /^\.transaction-[a-f0-9-]+\.commit$/i.test(name) || /^\..+\.[a-f0-9-]+\.(?:tmp|bak)$/i.test(name);
}

async function ensureMigrationBackup(
  projectPath: string,
  flowweaveRoot: string,
  backupRoot: string,
  manifest: MigrationBackupManifest
): Promise<void> {
  await assertSafeProjectWritePath(projectPath, backupRoot);
  if (await pathExists(backupRoot)) {
    const existing = JSON.parse(await readFile(join(backupRoot, "manifest.json"), "utf8")) as MigrationBackupManifest;
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error(`Migration backup manifest mismatch: ${backupRoot}`);
    for (const entry of manifest.files) {
      const archivedPath = join(backupRoot, "artifacts", ...entry.path.split("/"));
      if (await hashFile(archivedPath) !== entry.sha256) throw new Error(`Migration backup hash mismatch: ${archivedPath}`);
    }
    return;
  }

  const stagingRoot = `${backupRoot}.${randomUUID()}.tmp`;
  try {
    await mkdir(stagingRoot, { recursive: true });
    await assertSafeProjectWritePath(projectPath, stagingRoot);
    for (const entry of manifest.files) {
      const sourcePath = join(flowweaveRoot, ...entry.path.split("/"));
      const archivedPath = join(stagingRoot, "artifacts", ...entry.path.split("/"));
      await assertSafeProjectWritePath(projectPath, sourcePath);
      await assertSafeProjectWritePath(projectPath, archivedPath);
      await mkdir(dirname(archivedPath), { recursive: true });
      await copyFile(sourcePath, archivedPath);
      await syncFile(archivedPath);
      if (await hashFile(sourcePath) !== entry.sha256 || await hashFile(archivedPath) !== entry.sha256) {
        throw new Error(`FlowWeave artifact changed while its migration backup was created: ${sourcePath}`);
      }
      await syncDirectory(dirname(archivedPath));
    }
    const manifestPath = join(stagingRoot, "manifest.json");
    await durableWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await syncDirectory(stagingRoot);
    await rename(stagingRoot, backupRoot);
    await syncDirectory(dirname(backupRoot));
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readMigrationRecord(path: string): Promise<MigrationRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as MigrationRecord;
    if (record.version !== 1 || !["in-progress", "failed", "complete"].includes(record.status) || typeof record.attemptCount !== "number" || typeof record.sourceInventoryFingerprint !== "string") {
      throw new Error(`Invalid migration record: ${path}`);
    }
    return record;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeMigrationRecord(projectPath: string, path: string, record: MigrationRecord): Promise<void> {
  const directory = dirname(path);
  await assertSafeProjectWritePath(projectPath, path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.record-${randomUUID()}.tmp`);
  try {
    await durableWrite(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export type ArtifactUpdate = { path: string; content: string; validate?: (content: string) => void };
type JournalEntry = { path: string; temporaryPath: string; backupPath: string; originalExists: boolean; originalHash?: string; hash: string; delete?: true };
type TransactionJournal = { version: 2; transactionId: string; markerPath: string; entries: JournalEntry[] };
type StoredJournalEntry = { artifactPath: string; originalExists: boolean; originalHash?: string; hash: string; delete?: true };
type StoredTransactionJournal = { version: 2; transactionId: string; markerPath: string; entries: StoredJournalEntry[] };

/** Caller holds the project artifact lock. The journal is durable before any replacement. */
export async function writeBatchAtomic(projectPath: string, inputUpdates: ArtifactUpdate[], removedPaths?: string[], beforeCommit?: () => Promise<void>): Promise<void> {
  if (!inputUpdates.length) return;
  const projectRoot = await realpath(projectPath);
  const requestedUpdates = inputUpdates.map((update) => ({ ...update, path: join(projectRoot, relative(resolve(projectPath), resolve(update.path))) }));
  for (const update of requestedUpdates) {
    await assertSafeArtifactPath(projectRoot, update.path);
    if (await pathExists(update.path) && !(await lstat(update.path)).isFile()) {
      throw new Error(`Artifact target is not a regular file; previous artifacts were preserved: ${update.path}`);
    }
  }
  await recoverArtifactTransaction(projectRoot);
  const transactionId = randomUUID();
  const journalPath = join(projectRoot, FLOWWEAVE_DIR, "transaction.json");
  const generationMarker = basename(requestedUpdates.at(-1)!.path) === "generation.json";
  const writableUpdates: ArtifactUpdate[] = generationMarker ? requestedUpdates : [...requestedUpdates,
    { path: join(projectRoot, FLOWWEAVE_DIR, `.transaction-${transactionId}.commit`), content: transactionId }];
  const updates = [...writableUpdates.slice(0, -1), ...(removedPaths ?? []).map((path) => ({ path: join(projectRoot, relative(resolve(projectPath), resolve(path))), content: "", delete: true as const })), writableUpdates.at(-1)!];
  const targets = new Set<string>();
  for (const update of updates) {
    if (update.path === journalPath) throw new Error(`Artifact target conflicts with the transaction journal: ${update.path}`);
    if (targets.has(update.path)) throw new Error(`Duplicate artifact transaction target: ${update.path}`);
    targets.add(update.path);
    await assertSafeArtifactPath(projectRoot, update.path);
    if (await pathExists(update.path) && !(await lstat(update.path)).isFile()) throw new Error(`Artifact target is not a regular file: ${update.path}`);
  }
  const entries = await Promise.all(updates.map(async (update): Promise<JournalEntry> => {
    const originalExists = await pathExists(update.path);
    return {
      path: update.path,
      temporaryPath: join(dirname(update.path), `.${basename(update.path)}.${transactionId}.tmp`),
      backupPath: join(dirname(update.path), `.${basename(update.path)}.${transactionId}.bak`),
      originalExists,
      ...(originalExists ? { originalHash: contentHash(await readFile(update.path)) } : {}),
      hash: contentHash(update.content), ...("delete" in update ? { delete: true as const } : {})
    };
  }));
  const journal: TransactionJournal = { version: 2, transactionId,
    markerPath: updates.at(-1)!.path, entries };
  const journalText = JSON.stringify(storeJournal(projectRoot, journal));
  const pendingJournalPath = join(dirname(journalPath), `.transaction-${transactionId}.journal.tmp`);
  await mkdir(dirname(journalPath), { recursive: true });
  await writeTransactionAuthority(projectRoot, transactionId, journalText);
  let pendingJournalCreated = false;
  try {
    const handle = await open(pendingJournalPath, "wx", 0o600);
    pendingJournalCreated = true;
    try { await handle.writeFile(journalText, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(pendingJournalPath, journalPath);
    await syncDirectory(dirname(journalPath));
  } catch (error) {
    if (pendingJournalCreated) await rm(pendingJournalPath, { force: true });
    if (!await pathExists(journalPath)) await removeTransactionAuthority(projectRoot, transactionId);
    throw error;
  }
  let replacementsStarted = false;
  try {
    const staged = await Promise.allSettled(entries.map(async (entry, index) => {
      await assertSafeArtifactPath(projectRoot, entry.path);
      if (entry.delete) return;
      await mkdir(dirname(entry.path), { recursive: true });
      await durableWrite(entry.temporaryPath, updates[index].content);
      const update = updates[index];
      if ("validate" in update) update.validate?.(await readFile(entry.temporaryPath, "utf8"));
    }));
    const failures = staged.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, `Artifact staging failed: ${failures.map(String).join("; ")}`);
    await beforeCommit?.();
    await validatePreparedJournal(projectRoot, journal);
    replacementsStarted = true;
    for (const entry of entries) {
      if (entry.delete && !entry.originalExists) continue;
      await assertSafeArtifactPath(projectRoot, entry.path);
      if (entry.originalExists) {
        await rename(entry.path, entry.backupPath);
        await syncDirectory(dirname(entry.path));
      }
      if (!entry.delete) await rename(entry.temporaryPath, entry.path);
      await syncDirectory(dirname(entry.path));
    }
    await validateCommittedArtifacts(journal);
    const missingBackups = await validateCommittedBackups(journal);
    if (missingBackups.length) throw new Error(`Committed transaction backup is missing: ${missingBackups[0]}`);
  } catch (error) {
    try {
      if (replacementsStarted) await restoreJournal(projectRoot, journal);
      else await cleanupJournal(projectRoot, journal);
    }
    catch (recoveryError) { throw new TransactionRecoveryError(projectRoot, `transaction ${transactionId}; original: ${String(error)}; recovery: ${String(recoveryError)}`, new AggregateError([error, recoveryError])); }
    throw error;
  }
  // The final generation marker is authoritative even if journal cleanup is interrupted.
  try {
    await markTransactionCleanupStarted(projectRoot, transactionId, journalText);
    await cleanupJournal(projectRoot, journal);
  } catch (error) {
    // Committed data must not be rolled back or reported as an uncommitted scan.
    console.warn("Committed artifact transaction cleanup deferred", { projectRoot, transactionId, error });
  }
}

export async function recoverArtifactTransaction(projectRoot: string): Promise<void> {
  const canonicalRoot = await realpath(projectRoot);
  const journalPath = join(canonicalRoot, FLOWWEAVE_DIR, "transaction.json");
  if (!await pathExists(journalPath)) return;
  try {
    const info = await lstat(journalPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Transaction journal is not a regular file: ${journalPath}`);
    const journalText = await readFile(journalPath, "utf8");
    const value: unknown = JSON.parse(journalText);
    if (!isRecord(value) || value.version !== 2) {
      throw new Error(`Unsigned or unsupported transaction journal was preserved: ${journalPath}`);
    }
    if (typeof value.transactionId !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value.transactionId)) {
      throw new Error(`Invalid transaction journal ID: ${journalPath}`);
    }
    const cleanupStarted = await verifyTransactionAuthority(canonicalRoot, value.transactionId, journalText);
    const journal = await loadJournal(canonicalRoot, value);
    const marker = journal.entries.at(-1)!;
    const committed = await pathExists(marker.path) && contentHash(await readFile(marker.path, "utf8")) === marker.hash;
    if (committed) {
      await validateCommittedArtifacts(journal);
      const missingBackups = await validateCommittedBackups(journal);
      if (!cleanupStarted && missingBackups.length) throw new Error(`Committed transaction backup is missing: ${missingBackups[0]}`);
      await markTransactionCleanupStarted(canonicalRoot, journal.transactionId, journalText);
      await cleanupJournal(canonicalRoot, journal);
    } else {
      await restoreJournal(canonicalRoot, journal);
    }
  } catch (error) { throw new TransactionRecoveryError(canonicalRoot, `journal ${journalPath}`, error); }
}

function storeJournal(projectRoot: string, journal: TransactionJournal): StoredTransactionJournal {
  return {
    version: 2,
    transactionId: journal.transactionId,
    markerPath: artifactRelativePath(projectRoot, journal.markerPath),
    entries: journal.entries.map((entry) => ({
      artifactPath: artifactRelativePath(projectRoot, entry.path),
      originalExists: entry.originalExists,
      ...(entry.originalHash === undefined ? {} : { originalHash: entry.originalHash }),
      hash: entry.hash,
      ...(entry.delete ? { delete: true as const } : {})
    }))
  };
}

async function loadJournal(projectRoot: string, value: Record<string, unknown>): Promise<TransactionJournal> {
  if (typeof value.transactionId !== "string" || typeof value.markerPath !== "string" ||
    !Array.isArray(value.entries) || value.entries.length === 0) throw new Error("Invalid v2 transaction journal schema");
  const transactionId = value.transactionId;
  const entries: JournalEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.entries) {
    if (!isRecord(raw) || typeof raw.artifactPath !== "string" || typeof raw.originalExists !== "boolean" ||
      typeof raw.hash !== "string" || !/^[a-f\d]{64}$/i.test(raw.hash) ||
      (raw.originalExists && (typeof raw.originalHash !== "string" || !/^[a-f\d]{64}$/i.test(raw.originalHash))) ||
      (!raw.originalExists && raw.originalHash !== undefined) || (raw.delete !== undefined && raw.delete !== true)) {
      throw new Error("Invalid v2 transaction journal entry");
    }
    const path = artifactAbsolutePath(projectRoot, raw.artifactPath);
    if (seen.has(path)) throw new Error(`Duplicate transaction journal artifact: ${path}`);
    seen.add(path);
    const entry: JournalEntry = {
      path,
      temporaryPath: join(dirname(path), `.${basename(path)}.${transactionId}.tmp`),
      backupPath: join(dirname(path), `.${basename(path)}.${transactionId}.bak`),
      originalExists: raw.originalExists,
      ...(typeof raw.originalHash === "string" ? { originalHash: raw.originalHash } : {}),
      hash: raw.hash,
      ...(raw.delete === true ? { delete: true as const } : {})
    };
    for (const candidate of [entry.path, entry.temporaryPath, entry.backupPath]) {
      await assertSafeArtifactPath(projectRoot, candidate);
      if (await pathExists(candidate) && !(await lstat(candidate)).isFile()) {
        throw new Error(`Transaction journal path is not a regular file: ${candidate}`);
      }
    }
    entries.push(entry);
  }
  const markerPath = artifactAbsolutePath(projectRoot, value.markerPath);
  const expectedCommitMarker = join(projectRoot, FLOWWEAVE_DIR, `.transaction-${transactionId}.commit`);
  if (markerPath !== entries.at(-1)!.path || entries.at(-1)!.delete ||
    (markerPath !== join(projectRoot, FLOWWEAVE_DIR, "generation.json") && markerPath !== expectedCommitMarker)) {
    throw new Error(`Invalid v2 transaction commit marker: ${markerPath}`);
  }
  return { version: 2, transactionId, markerPath, entries };
}

function artifactRelativePath(projectRoot: string, path: string): string {
  const relativePath = relative(join(projectRoot, FLOWWEAVE_DIR), path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Transaction artifact escapes ${FLOWWEAVE_DIR}: ${path}`);
  }
  return relativePath.split(sep).join("/");
}

function artifactAbsolutePath(projectRoot: string, artifactPath: string): string {
  const segments = artifactPath.split("/");
  if (!artifactPath || artifactPath.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error(`Unsafe transaction artifact path: ${artifactPath}`);
  }
  return join(projectRoot, FLOWWEAVE_DIR, ...segments);
}

async function assertSafeArtifactPath(projectRoot: string, path: string): Promise<void> {
  artifactRelativePath(projectRoot, path);
  await assertSafeProjectWritePath(projectRoot, path);
}

async function validatePreparedJournal(projectRoot: string, journal: TransactionJournal): Promise<void> {
  for (const entry of journal.entries) {
    for (const path of [entry.path, entry.temporaryPath, entry.backupPath]) await assertSafeArtifactPath(projectRoot, path);
    if (await pathExists(entry.backupPath)) throw new Error(`Transaction backup already exists: ${entry.backupPath}`);
    if (entry.originalExists) {
      if (!await pathExists(entry.path) || contentHash(await readFile(entry.path)) !== entry.originalHash) {
        throw new Error(`Transaction original artifact changed before replacement: ${entry.path}`);
      }
    } else if (await pathExists(entry.path)) throw new Error(`Transaction target appeared before replacement: ${entry.path}`);
    if (!entry.delete && (!await pathExists(entry.temporaryPath) || contentHash(await readFile(entry.temporaryPath)) !== entry.hash)) {
      throw new Error(`Transaction staged artifact content mismatch: ${entry.temporaryPath}`);
    }
  }
}

async function validateRollbackState(journal: TransactionJournal): Promise<void> {
  for (const entry of journal.entries) {
    if (await pathExists(entry.temporaryPath) && (entry.delete || contentHash(await readFile(entry.temporaryPath)) !== entry.hash)) {
      throw new Error(`Recovery staged artifact content mismatch: ${entry.temporaryPath}`);
    }
    if (await pathExists(entry.backupPath)) {
      if (!entry.originalHash || contentHash(await readFile(entry.backupPath)) !== entry.originalHash) {
        throw new Error(`Recovery backup content mismatch: ${entry.backupPath}`);
      }
      if (await pathExists(entry.path)) {
        const currentHash = contentHash(await readFile(entry.path));
        if (currentHash !== entry.originalHash && currentHash !== entry.hash) {
          throw new Error(`Recovery target changed after interruption: ${entry.path}`);
        }
      }
    } else if (entry.originalExists) {
      if (!entry.originalHash || !await pathExists(entry.path) || contentHash(await readFile(entry.path)) !== entry.originalHash) {
        throw new Error(`Recovery backup is missing and the original artifact cannot be verified: ${entry.backupPath}`);
      }
    } else if (await pathExists(entry.path) && (entry.delete || contentHash(await readFile(entry.path)) !== entry.hash)) {
      throw new Error(`Recovery created artifact content mismatch: ${entry.path}`);
    }
  }
}

async function validateCommittedBackups(journal: TransactionJournal): Promise<string[]> {
  const missingBackups: string[] = [];
  for (const entry of journal.entries) {
    if (await pathExists(entry.temporaryPath)) throw new Error(`Committed transaction has an unexpected staged artifact: ${entry.temporaryPath}`);
    if (!entry.originalExists) {
      if (await pathExists(entry.backupPath)) throw new Error(`Committed transaction has an unexpected backup: ${entry.backupPath}`);
      continue;
    }
    if (!await pathExists(entry.backupPath)) {
      missingBackups.push(entry.backupPath);
      continue;
    }
    if (contentHash(await readFile(entry.backupPath)) !== entry.originalHash) {
      throw new Error(`Committed transaction backup content mismatch: ${entry.backupPath}`);
    }
  }
  return missingBackups;
}

async function validateCommittedArtifacts(journal: TransactionJournal): Promise<void> {
  for (const entry of journal.entries) {
    if (entry.delete ? await pathExists(entry.path) : !await pathExists(entry.path) || contentHash(await readFile(entry.path)) !== entry.hash) {
      throw new Error(`Committed artifact content mismatch: ${entry.path}`);
    }
  }
}

async function restoreJournal(projectRoot: string, journal: TransactionJournal): Promise<void> {
  await validateRollbackState(journal);
  const failures: unknown[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      if (await pathExists(entry.backupPath)) {
        if (entry.originalHash && contentHash(await readFile(entry.backupPath)) !== entry.originalHash) {
          throw new Error(`Recovery backup content mismatch: ${entry.backupPath}`);
        }
        await copyFile(entry.backupPath, entry.path);
        const handle = await open(entry.path, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(dirname(entry.path));
      }
      else if (entry.originalExists) {
        if (!entry.originalHash || !await pathExists(entry.path) || contentHash(await readFile(entry.path)) !== entry.originalHash) {
          throw new Error(`Recovery backup is missing and the original artifact cannot be verified: ${entry.backupPath}`);
        }
      } else await rm(entry.path, { force: true });
      await rm(entry.temporaryPath, { force: true });
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Rollback errors: ${failures.map(String).join("; ")}`);
  await cleanupJournal(projectRoot, journal);
}

async function cleanupJournal(projectRoot: string, journal: TransactionJournal): Promise<void> {
  const results = await Promise.allSettled(journal.entries.flatMap((entry) => [rm(entry.backupPath, { force: true }), rm(entry.temporaryPath, { force: true })]));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Committed transaction cleanup failed");
  await rm(join(projectRoot, FLOWWEAVE_DIR, "transaction.json"));
  if (journal.markerPath && basename(journal.markerPath) === `.transaction-${journal.transactionId}.commit`) await rm(journal.markerPath, { force: true });
  await removeTransactionAuthority(projectRoot, journal.transactionId);
}

async function durableWrite(path: string, content: string): Promise<void> {
  const handle = await open(path, "w");
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
}

function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function jsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

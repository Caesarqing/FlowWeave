import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const appRoot = process.cwd();
const packagedExecutable = process.env.FLOWWEAVE_PACKAGED_EXECUTABLE;
const executable = resolve(packagedExecutable ?? require("electron"));
const screenshotBasePath = process.env.FLOWWEAVE_GRAPH_SMOKE_SCREENSHOT;
const allFixtures = ["edges", "empty", "four-languages", "save-failure", "tab-switch", "viewport-only", "details-race"];
const requestedFixture = process.env.FLOWWEAVE_GRAPH_SMOKE_FIXTURE;
if (requestedFixture && !allFixtures.includes(requestedFixture)) {
  throw new Error(`Unknown graph smoke fixture ${requestedFixture}; choose one of: ${allFixtures.join(", ")}.`);
}
const fixtures = requestedFixture ? [requestedFixture] : allFixtures;
await access(executable);
if (!packagedExecutable) await access(join(appRoot, "out", "main", "index.js"));

for (const fixture of fixtures) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `flowweave-graph-smoke-${fixture}-`));
  try {
    const projectPath = join(temporaryRoot, "project");
    const userDataPath = join(temporaryRoot, "user-data");
    const emptyToolchainPath = join(temporaryRoot, "no-toolchain");
    const reportPath = join(temporaryRoot, "rendered-graph.json");
    await mkdir(userDataPath, { recursive: true });
    await mkdir(emptyToolchainPath);
    await createFixture(projectPath, fixture);
    const secondProjectPath = fixture === "tab-switch" ? join(temporaryRoot, "second-project") : undefined;
    if (secondProjectPath) await createFixture(secondProjectPath, "empty");
    try {
      await runElectron(projectPath, userDataPath, emptyToolchainPath, reportPath, fixture, secondProjectPath);
    } catch (error) {
      if (process.env.FLOWWEAVE_GRAPH_SMOKE_EVIDENCE_PATH) await retainSmokeReport(reportPath, fixture);
      throw error;
    }
    if (process.env.FLOWWEAVE_GRAPH_SMOKE_EVIDENCE_PATH) {
      await retainSmokeReport(reportPath, fixture);
    }
    const index = await readArtifact(join(projectPath, ".flowweave", "index", "semantic-index.json"));
    const { architecture, canvas, snapshot, manifest } = await readCommittedGraph(projectPath);
    const rendered = await readArtifact(reportPath);
    if (process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE === "1" ||
      process.env.FLOWWEAVE_GRAPH_SMOKE_LAYOUT_STATE === "1") {
      assertCanvasLayoutSnapshots(rendered.reactProfiler?.layoutSnapshots);
    }
    if (process.env.FLOWWEAVE_GRAPH_SMOKE_COMPONENT_PROFILE === "1") {
      assertCanvasComponentProfilerSamples(rendered.reactProfiler);
    }
    if (process.env.FLOWWEAVE_GRAPH_SMOKE_LAYOUT_STATE === "1" && process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE !== "1") {
      if (rendered.status !== "completed" || rendered.fixture !== fixture) {
        throw new Error(`Layout-state smoke report has an unexpected status: ${JSON.stringify({ status: rendered.status, fixture: rendered.fixture })}.`);
      }
      console.log("Persisted Canvas layout-state snapshots passed.");
      continue;
    }
    if (fixture === "details-race") {
      const race = rendered.detailsRace;
      if (race?.status !== "passed" || race.heldNodeId !== race.accountNodeId || race.releasedNodeId !== race.accountNodeId ||
        race.beforeRelease?.title !== race.orderTitle || race.afterRelease?.title !== race.orderTitle ||
        !race.beforeRelease?.hasOrderSymbol || race.beforeRelease.hasAccountSymbol ||
        !race.afterRelease?.hasOrderSymbol || race.afterRelease.hasAccountSymbol) {
        throw new Error(`Graph smoke did not verify that the delayed account detail response leaves order details selected: ${JSON.stringify(race)}.`);
      }
    }
    if (fixture === "four-languages") {
      const navigation = rendered.keyboardNavigation;
      if (!navigation?.groupNodeId || !navigation.expandedFocusedNodeId ||
        navigation.expandedFocusedNodeId === navigation.groupNodeId ||
        navigation.overviewFocusedNodeId !== navigation.groupNodeId) {
        throw new Error(`Graph smoke did not verify Enter expansion and Escape focus restoration: ${JSON.stringify(navigation)}.`);
      }
    }
    if (fixture === "four-languages" || fixture === "viewport-only") {
      if (fixture === "viewport-only" && (rendered.status !== "completed" || rendered.fixture !== fixture)) {
        throw new Error(`Viewport-only graph smoke report has an unexpected status: ${JSON.stringify({ status: rendered.status, fixture: rendered.fixture })}.`);
      }
      const expectedWindowViewports = [[960, 640], [1440, 900], [1920, 1080]];
      if (!Array.isArray(rendered.viewportSamples) || rendered.viewportSamples.length !== expectedWindowViewports.length) {
        throw new Error(`Graph smoke did not record all target window viewport samples: ${JSON.stringify(rendered.viewportSamples)}.`);
      }
      for (const [index, sample] of rendered.viewportSamples.entries()) {
        const [windowWidth, windowHeight] = expectedWindowViewports[index];
        if (sample.windowWidth !== windowWidth || sample.windowHeight !== windowHeight ||
          !Number.isFinite(sample.stageWidth) || !Number.isFinite(sample.stageHeight) ||
          sample.stageWidth < 1 || sample.stageHeight < 1 || sample.detailPanelVisible !== true ||
          sample.overlappingNodePairCount !== 0 ||
          !sample.requiredCanvasControlsReachable || Object.keys(sample.requiredCanvasControlsReachable).length !== 6 ||
          Object.values(sample.requiredCanvasControlsReachable).some((reachable) => reachable !== true) ||
          !Number.isFinite(sample.flowZoom) || sample.flowZoom <= 0 ||
          !Number.isFinite(sample.smallestVisibleTitleFontPx) || sample.smallestVisibleTitleFontPx < 14 ||
          !Number.isFinite(sample.smallestVisibleBodyFontPx) || sample.smallestVisibleBodyFontPx < 12 ||
          typeof sample.readabilityWarning !== "boolean" || typeof sample.readabilityWarningText !== "string" ||
          sample.smallestVisibleTitleFontPx === null || sample.smallestVisibleBodyFontPx === null) {
          throw new Error(`Graph smoke viewport sample ${index} is incomplete: ${JSON.stringify(sample)}.`);
        }
      }
      console.log(`Canvas stage measurements in target app windows (${fixture}): ${JSON.stringify(rendered.viewportSamples.map(({ windowWidth, windowHeight, stageWidth, stageHeight, visibleNodeCount, overlappingNodePairCount, flowZoom, smallestVisibleTitleFontPx, smallestVisibleBodyFontPx, detailPanelVisible, requiredCanvasControlsReachable, readabilityWarning, readabilityWarningText }) => ({ windowWidth, windowHeight, stageWidth, stageHeight, visibleNodeCount, overlappingNodePairCount, flowZoom, smallestVisibleTitleFontPx, smallestVisibleBodyFontPx, detailPanelVisible, requiredCanvasControlsReachable, readabilityWarning, readabilityWarningText })))}.`);
    }
    if (fixture === "edges" && !rendered.closeSavedTitle) throw new Error("Graph smoke did not verify the close save barrier.");
    if (fixture === "save-failure" && !rendered.failedSavePreservedEdit) {
      throw new Error("Graph smoke did not verify that a failed save stops refresh and preserves the edit.");
    }
    if (fixture === "tab-switch" && !rendered.switchSavedTitle) {
      throw new Error("Graph smoke did not verify the project-switch save barrier.");
    }
    if (manifest.storageProtocol !== 7 || snapshot.schemaVersion !== 1 || index.version !== 5) {
      throw new Error(`Graph smoke artifact versions are stale: protocol=${manifest.storageProtocol} snapshot=${snapshot.schemaVersion} semantic=${index.version}`);
    }
    if (index.diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new Error(`Graph smoke analysis failed: ${JSON.stringify(index.diagnostics)}`);
    if (canvas.layout.viewMode !== "execution" || rendered.viewMode !== "execution") throw new Error(`Graph smoke fixture ${fixture} must open the functional-call view.`);
    if (fixture === "edges") {
      checkRelations(index, [
        ["call", "src/features/accounts/account.service.ts", "src/features/orders/order.service.ts"],
        ["render", "frontend/src/app/router.tsx", "frontend/src/pages/news/News.tsx"],
        ["import", "backend/services/news-service/app.js", "backend/services/shared/node/queue.js"],
        ["call", "backend/services/news-service/app.js", "backend/services/shared/node/queue.js"],
        ["import", "backend/services/news_scraper/app.py", "backend/services/shared/python/retry.py"],
        ["call", "backend/services/news_scraper/app.py", "backend/services/shared/python/retry.py"]
      ]);
    }
    if (fixture === "four-languages" || fixture === "viewport-only") {
      checkRelations(index, [
        ["call", "plugin/packages/dashboard/src/app.ts", "plugin/packages/core/src/service.ts"],
        ["call", "python/src/sample/app.py", "python/src/sample/service.py"],
        ["call", "java/src/main/java/example/App.java", "java/src/main/java/example/Service.java"],
        ["call", "go/main.go", "go/service/service.go"]
      ]);
      const calls = index.relations.filter((relation) => relation.kind === "call" && relation.sourceFile === "plugin/packages/dashboard/src/app.ts" && relation.targetFile === "plugin/packages/core/src/service.ts");
      if (calls.length !== 2 || calls[0].id === calls[1].id) throw new Error("Graph smoke lost one of the two real TypeScript call sites.");
      checkResourceEdges(index, architecture, canvas, rendered);
    }
    const defaultCallEdges = canvas.edges.filter((edge) => edge.relation === "calls" && edge.confidence === "confirmed");
    if (fixture !== "empty") {
      if (!defaultCallEdges.length || !rendered.edges.length) throw new Error(`Graph smoke fixture ${fixture} rendered no confirmed call edges.`);
      for (const edge of defaultCallEdges) checkRenderedEdge(rendered, edge);
    } else if (rendered.edges.length) throw new Error("Empty graph smoke rendered invented edges.");
    console.log(`Graph smoke artifacts verified: ${fixture}; protocol=v${manifest.storageProtocol}; semantic=v${index.version}; ReactFlow edges=${rendered.edges.length}; toolchain PATH empty.`);
    if (fixture === "edges") {
      await verifyPackagedConcurrency(projectPath, temporaryRoot, emptyToolchainPath);
      const [latestGraph, latestIndex] = await Promise.all([
        readCommittedGraph(projectPath),
        readArtifact(join(projectPath, ".flowweave", "index", "semantic-index.json"))
      ]);
      await verifyLegacyMigrationBackup(projectPath, temporaryRoot, emptyToolchainPath, latestGraph.canvas, latestIndex);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertCanvasLayoutSnapshots(snapshots) {
  const requiredActions = ["expand-group", "collapse-group", "automatic-layout-refresh"];
  if (!Array.isArray(snapshots) || snapshots.length !== requiredActions.length) {
    throw new Error("React Profiler smoke did not record exactly three persisted Canvas layout snapshots.");
  }
  for (const action of requiredActions) {
    const snapshot = snapshots.find((item) => item.action === action);
    if (!snapshot || snapshot.status !== "persisted" || !Number.isInteger(snapshot.positionCount) || snapshot.positionCount < 1 ||
      !Number.isInteger(snapshot.handlePositionCount) || snapshot.handlePositionCount < 1 ||
      !Number.isInteger(snapshot.matchingPositionCount) || snapshot.matchingPositionCount !== snapshot.handlePositionCount ||
      !snapshot.baselineAutoLayoutTopologyFingerprint || !snapshot.baselineHandleTopologyFingerprint ||
      !snapshot.autoLayoutTopologyFingerprint || !snapshot.handleTopologyFingerprint ||
      snapshot.baselineAutoLayoutTopologyFingerprint === snapshot.autoLayoutTopologyFingerprint ||
      snapshot.baselineHandleTopologyFingerprint === snapshot.handleTopologyFingerprint ||
      !snapshot.topologyChanged || !Number.isInteger(snapshot.userRevision)) {
      throw new Error(`React Profiler smoke did not verify an atomic persisted positions/ELK-handle layout for ${action}: ${JSON.stringify(snapshot)}.`);
    }
    const autoTopology = JSON.parse(snapshot.autoLayoutTopologyFingerprint);
    const handleTopology = JSON.parse(snapshot.handleTopologyFingerprint);
    if (!autoTopology || typeof autoTopology !== "object" || Array.isArray(autoTopology) ||
      !handleTopology || typeof handleTopology !== "object" || Array.isArray(handleTopology)) {
      throw new Error(`Canvas layout topology fingerprint is not an object for ${action}.`);
    }
    const autoTopologyKeys = Object.keys(autoTopology).filter((key) => key !== "context").sort();
    const handleTopologyKeys = Object.keys(handleTopology).sort();
    if (autoTopologyKeys.join(",") !== "edgeKeys,layoutVersion,nodeIds" ||
      handleTopologyKeys.join(",") !== "edgeKeys,layoutVersion,nodeIds" ||
      autoTopologyKeys.some((key) => JSON.stringify(autoTopology[key]) !== JSON.stringify(handleTopology[key]))) {
      throw new Error(`Canvas auto-layout and handle-layout topology differ for ${action}: ${JSON.stringify({ autoTopologyKeys, handleTopologyKeys })}.`);
    }
    if (action === "expand-group" && snapshot.targetGroupPresent !== false) {
      throw new Error(`Expanded Canvas group remained in the persisted handle topology: ${JSON.stringify(snapshot)}.`);
    }
    if (action === "collapse-group" && snapshot.targetGroupPresent !== true) {
      throw new Error(`Collapsed Canvas group was missing from the persisted handle topology: ${JSON.stringify(snapshot)}.`);
    }
    if (action === "automatic-layout-refresh" &&
      (snapshot.layoutMode !== "dependency" || snapshot.runtimeLayoutContext !== true)) {
      throw new Error(`Automatic layout refresh did not persist the dependency mode in the current runtime context: ${JSON.stringify(snapshot)}.`);
    }
  }
  const [expand, collapse, refresh] = requiredActions.map((action) => snapshots.find((item) => item.action === action));
  if (!(expand.userRevision < collapse.userRevision && collapse.userRevision < refresh.userRevision)) {
    throw new Error(`React Profiler smoke layout snapshots did not advance independently for each action: ${JSON.stringify([expand, collapse, refresh])}.`);
  }
}

function assertCanvasComponentProfilerSamples(profiler) {
  const requiredComponents = ["CanvasWorkspace", "CanvasModuleNode", "CanvasGroupNode", "CanvasSmoothStepEdge", "CanvasModulePanel", "CanvasConnectionPanel"];
  if (profiler?.status !== "completed" || !Array.isArray(profiler.samples)) {
    throw new Error("Component profiler smoke did not complete with raw samples.");
  }
  for (const componentId of requiredComponents) {
    if (!profiler.samples.some((sample) => sample.componentId === componentId)) {
      throw new Error(`Component profiler smoke has no sample for ${componentId}.`);
    }
  }
  for (const [action, componentId] of [
    ["profile-module-panel", "CanvasModulePanel"],
    ["profile-connection-panel", "CanvasConnectionPanel"]
  ]) {
    if (!profiler.samples.some((sample) => sample.action === action && sample.componentId === componentId)) {
      throw new Error(`Component profiler smoke recorded no ${componentId} timing during ${action}.`);
    }
  }
}

async function retainSmokeReport(reportPath, fixture) {
  const configuredEvidencePath = process.env.FLOWWEAVE_GRAPH_SMOKE_EVIDENCE_PATH;
  if (!configuredEvidencePath) return;
  try {
    await access(reportPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.error(`Graph smoke fixture ${fixture} produced no report to retain: ${reportPath}.`);
      return;
    }
    throw error;
  }
  const evidencePath = resolve(configuredEvidencePath);
  await mkdir(dirname(evidencePath), { recursive: true });
  try {
    await copyFile(reportPath, evidencePath, constants.COPYFILE_EXCL);
    console.log(`Graph smoke report retained without replacing existing evidence: ${evidencePath}.`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      console.error(`Graph smoke evidence already exists and was not overwritten: ${evidencePath}.`);
      return;
    }
    throw error;
  }
}

async function verifyPackagedConcurrency(projectPath, temporaryRoot, emptyToolchainPath) {
  const barrier = join(temporaryRoot, "generation-barrier");
  const olderReport = join(temporaryRoot, "older-generation.json");
  const newerReport = join(temporaryRoot, "newer-generation.json");
  const older = startGenerationProcess(projectPath, temporaryRoot, emptyToolchainPath, "older", barrier, olderReport);
  try {
    await waitForFile(`${barrier}.ready`);
    const newer = startGenerationProcess(projectPath, temporaryRoot, emptyToolchainPath, "newer", barrier, newerReport);
    const newerExit = await newer.done;
    if (newerExit.code !== 0) throw new Error(`Packaged newer generation failed: exit=${newerExit.code}; signal=${newerExit.signal}.`);
  } finally {
    await writeFile(`${barrier}.release`, "release", "utf8");
  }
  const olderExit = await older.done;
  if (olderExit.code !== 0) throw new Error(`Packaged older generation failed: exit=${olderExit.code}; signal=${olderExit.signal}.`);
  const [olderResult, newerResult, committed] = await Promise.all([
    readArtifact(olderReport),
    readArtifact(newerReport),
    readArtifact(join(projectPath, ".flowweave", "generation.json"))
  ]);
  if (newerResult.status !== "committed" || olderResult.status !== "superseded" || committed.generationId !== newerResult.generation?.requestId) {
    throw new Error(`Packaged cross-process request ordering failed: ${JSON.stringify({ olderResult, newerResult, committed })}.`);
  }
  const root = join(projectPath, ".flowweave");
  const artifactPaths = [
    "generation.json", "static-snapshot.json", "graph-overview.json", "canvas/user-state.json",
    "index/manifest.json", "index/semantic-index.json"
  ];
  const artifacts = await Promise.all(artifactPaths.map((path) => readArtifact(join(root, path))));
  for (const [index, artifact] of artifacts.entries()) {
    const matchesGeneration = artifact.generationId === newerResult.generation.requestId ||
      (artifact.generation?.requestId === newerResult.generation.requestId && artifact.generation?.inputFingerprint === newerResult.generation.inputFingerprint);
    if (!matchesGeneration) {
      throw new Error(`Packaged generation artifact ${artifactPaths[index]} has a mismatched identity.`);
    }
  }
  console.log(`Packaged cross-process generation verified: newer request committed; older request superseded; ${artifacts.length} artifact identities match.`);
}

function startGenerationProcess(projectPath, temporaryRoot, emptyToolchainPath, role, barrier, reportPath) {
  const userDataPath = join(temporaryRoot, `${role}-generation-user-data`);
  const args = packagedExecutable
    ? ["--flowweave-generation-smoke-test"]
    : [appRoot, "--flowweave-generation-smoke-test"];
  const child = spawn(executable, args, {
    env: {
      ...process.env,
      PATH: emptyToolchainPath,
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_RENDERER_URL: undefined,
      FLOWWEAVE_GENERATION_SMOKE_PROJECT: projectPath,
      FLOWWEAVE_GENERATION_SMOKE_USER_DATA: userDataPath,
      FLOWWEAVE_GENERATION_SMOKE_ROLE: role,
      FLOWWEAVE_GENERATION_SMOKE_BARRIER: barrier,
      FLOWWEAVE_GENERATION_SMOKE_REPORT: reportPath
    },
    stdio: "inherit",
    windowsHide: true
  });
  const done = new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Packaged ${role} generation smoke exceeded 120 seconds.`)); }, 120_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal });
    });
  });
  return { child, done };
}

async function waitForFile(path) {
  const startedAt = Date.now();
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() - startedAt > 30_000) throw new Error(`Generation smoke barrier was not reached: ${path}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function verifyLegacyMigrationBackup(projectPath, temporaryRoot, emptyToolchainPath, currentCanvas, currentIndex) {
  const canvasPath = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
  const legacyCanvas = { ...currentCanvas, version: 5 };
  await writeFile(canvasPath, `${JSON.stringify(legacyCanvas, null, 2)}\n`, "utf8");
  const legacyBytes = await readFile(canvasPath);
  await Promise.all([
    rm(join(projectPath, ".flowweave", "generation.json"), { force: true }),
    rm(join(projectPath, ".flowweave", "static-snapshot.json"), { force: true }),
    rm(join(projectPath, ".flowweave", "graph-overview.json"), { force: true }),
    rm(join(projectPath, ".flowweave", "canvas", "user-state.json"), { force: true })
  ]);
  await writeFile(join(projectPath, "frontend", "tsconfig.json"), "{ broken", "utf8");
  const reportPath = join(temporaryRoot, "failed-migration.json");
  await runElectron(projectPath, join(temporaryRoot, "failed-migration-user-data"), emptyToolchainPath, reportPath, "migration-failure", undefined);
  const [afterCanvas, afterIndex, rendered, record] = await Promise.all([
    readFile(canvasPath),
    readArtifact(join(projectPath, ".flowweave", "index", "semantic-index.json")),
    readArtifact(reportPath),
    readArtifact(join(projectPath, ".flowweave", "migration", "record.json"))
  ]);
  if (!afterCanvas.equals(legacyBytes)) throw new Error("Packaged failed migration modified the legacy v5 Canvas.");
  if (afterIndex.generation?.requestId !== currentIndex.generation?.requestId) {
    throw new Error("Packaged failed migration changed the previously committed semantic index.");
  }
  const backupPath = join(projectPath, record.backupPath, "artifacts", "canvas", "main.canvas.json");
  if (record.status !== "failed" || !(await readFile(backupPath)).equals(legacyBytes)) {
    throw new Error("Packaged failed migration did not retain a verified byte-for-byte source backup.");
  }
  if (rendered.nodes !== 0 || !/failed|失败/i.test(rendered.projectStatus)) {
    throw new Error(`Packaged app displayed the legacy graph after migration failed: ${JSON.stringify(rendered)}.`);
  }
  console.log("Packaged failed migration verified: source bytes archived and the old graph stayed out of normal runtime.");
}

async function readArtifact(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCommittedGraph(projectPath) {
  const root = join(projectPath, ".flowweave");
  const [manifest, snapshot, overview, userState] = await Promise.all([
    readArtifact(join(root, "generation.json")),
    readArtifact(join(root, "static-snapshot.json")),
    readArtifact(join(root, "graph-overview.json")),
    readArtifact(join(root, "canvas", "user-state.json"))
  ]);
  if (manifest.generationId !== snapshot.generationId || manifest.generationId !== overview.generationId || manifest.generationId !== userState.generationId) {
    throw new Error(`Graph smoke observed mixed protocol generations: ${projectPath}`);
  }
  return {
    manifest,
    snapshot,
    architecture: snapshot.localArchitecture,
    canvas: {
      version: 6,
      generatorVersion: overview.generatorVersion,
      id: "main",
      title: "Main Canvas",
      projectPath,
      generatedAt: overview.generatedAt,
      artifactState: "current",
      inputFingerprint: manifest.inputFingerprint,
      generation: { requestId: manifest.generationId, inputFingerprint: manifest.inputFingerprint },
      scanFingerprint: overview.scanFingerprint,
      layout: userState.layout,
      nodes: [...overview.nodes.map((node) => ({ ...node, origin: "generated" })), ...userState.manualNodes],
      edges: [...overview.edges.map((edge) => ({ ...edge, origin: "generated" })), ...userState.manualEdges],
      groups: overview.groups,
      quality: overview.quality,
      orphanedEdges: userState.orphanedEdges
    }
  };
}

function checkRelations(index, expectedRelations) {
  for (const [kind, sourceFile, targetFile] of expectedRelations) {
    const relation = index.relations.find((item) => item.kind === kind && item.sourceFile === sourceFile && item.targetFile === targetFile);
    if (!relation || !relation.sourceRange || !relation.targetRef?.declarationRange && kind === "call") throw new Error(`Graph smoke missing located relation: ${kind} ${sourceFile} -> ${targetFile}`);
    if (relation.sourceRange.start.line < 1 || relation.sourceRange.start.column < 1 || relation.sourceRange.end.line < relation.sourceRange.start.line) throw new Error(`Graph smoke invalid source range: ${JSON.stringify(relation)}`);
  }
}

function checkResourceEdges(index, architecture, canvas, rendered) {
  const expectations = [
    ["api", "POST https://fixture.flowweave.invalid/v1/users", "http", "write", "external_api"],
    ["filesystem", "/flowweave-graph-smoke/fixture.txt", "filesystem", "read", "reads"],
    ["event", "graph-smoke-ready", "event", "publish", "publishes_event"],
    ["event", "graph-smoke-ready", "event", "subscribe", "subscribes_event"]
  ];
  for (const [resourceKind, title, semanticKind, operation, relationKind] of expectations) {
    const resources = index.resources.filter((resource) => resource.kind === resourceKind && resource.title === title);
    if (resources.length !== 1) throw new Error(`Graph smoke expected one canonical ${resourceKind} resource ${title}, got ${resources.length}.`);
    const resource = resources[0];
    const fact = index.relations.find((relation) => relation.kind === semanticKind && relation.operation === operation && relation.targetRef?.kind === "resource" && relation.targetRef.resourceId === resource.id);
    if (!fact || fact.confidence !== "confirmed" || !fact.sourceRange) throw new Error(`Graph smoke missing confirmed ${operation} resource fact: ${resource.id}`);
    const actor = architecture.modules.find((module) => module.files.includes(fact.sourceFile));
    if (!actor) throw new Error(`Graph smoke has no module for resource actor ${fact.sourceFile}`);
    const source = operation === "subscribe" ? resource.id : actor.id;
    const target = operation === "subscribe" ? actor.id : resource.id;
    const edge = canvas.edges.find((item) => item.source === source && item.target === target && item.relation === relationKind);
    if (!edge || !canvas.nodes.some((node) => node.id === resource.id && node.resource?.id === resource.id)) {
      throw new Error(`Graph smoke missing canonical ${relationKind} edge ${source} -> ${target}: ${JSON.stringify({ edge, matchingEdges: canvas.edges.filter((item) => item.source === source || item.target === target), resourceNode: canvas.nodes.find((node) => node.id === resource.id) })}`);
    }
  }
}

function checkRenderedEdge(rendered, edge) {
  const actual = rendered.edges.find((item) => item.id === edge.id);
  if (!actual || !actual.path || /NaN|Infinity/.test(actual.path) || !actual.markerEnd || actual.label !== `Edge from ${edge.source} to ${edge.target}` || !rendered.nodeIds.includes(edge.source) || !rendered.nodeIds.includes(edge.target)) throw new Error(`Graph smoke missing directed ReactFlow SVG edge: ${JSON.stringify({ expected: edge, actual })}`);
}

async function createFixture(projectPath, fixture) {
  if (fixture === "four-languages" || fixture === "viewport-only") {
    await cp(join(appRoot, "tests", "fixtures", "four-language-workspace"), projectPath, { recursive: true });
    await writeFile(join(projectPath, "plugin/packages/dashboard/src/resources.ts"), "import { readFile } from 'node:fs/promises';\nimport { EventEmitter } from 'node:events';\nexport const emitter = new EventEmitter();\nexport function inspect() {\n  readFile('/flowweave-graph-smoke/fixture.txt');\n  fetch('https://fixture.flowweave.invalid/v1/users', { method: 'POST' });\n  emitter.emit('graph-smoke-ready');\n}\n");
    await writeFile(join(projectPath, "plugin/packages/dashboard/src/resource-observer.ts"), "import { emitter } from './resources';\nexport function observe() { emitter.on('graph-smoke-ready', () => {}); }\n");
    return;
  }
  const accounts = join(projectPath, "src", "features", "accounts", "account.service.ts");
  const orders = join(projectPath, "src", "features", "orders", "order.service.ts");
  await mkdir(dirname(accounts), { recursive: true });
  await mkdir(dirname(orders), { recursive: true });
  await writeFile(accounts, fixture === "details-race"
    ? 'import { loadOrderDetailRaceMarker } from "../orders/order.service";\nexport function loadAccountDetailRaceMarker() { return loadOrderDetailRaceMarker(); }\n'
    : fixture === "edges" || fixture === "save-failure" || fixture === "tab-switch"
      ? 'import { loadOrder } from "../orders/order.service";\nexport function loadAccount() { return loadOrder(); }\n'
      : "export function loadAccount() { return 1; }\n", "utf8");
  await writeFile(orders, fixture === "details-race"
    ? 'export function loadOrderDetailRaceMarker() { return "order-detail-race-marker"; }\n'
    : "export function loadOrder() { return 2; }\n", "utf8");
  if (fixture === "edges") {
    const files = {
      "frontend/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] }, jsx: "react-jsx" } }),
      "frontend/src/app/router.tsx": 'import { News } from "~/pages/news/News";\nexport function Router() { return <News />; }\n',
      "frontend/src/pages/news/News.tsx": "export function News() { return <div>News</div>; }\n",
      "backend/pyproject.toml": '[project]\nname = "graph-smoke-backend"\nversion = "0.1.0"\n[tool.setuptools.package-dir]\n"" = "."\n',
      "backend/services/news-service/app.js": 'const { publish } = require("../shared/node/queue");\nexports.run = () => publish();\n',
      "backend/services/shared/node/queue.js": "exports.publish = () => 1;\n",
      "backend/services/news_scraper/app.py": "from services.shared.python.retry import retry\ndef scrape():\n    return retry()\n",
      "backend/services/shared/python/retry.py": "def retry():\n    return 1\n"
    };
    for (const [relativePath, content] of Object.entries(files)) {
      const path = join(projectPath, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
  }
}

function runElectron(projectPath, userDataPath, emptyToolchainPath, reportPath, expected, secondProjectPath) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, packagedExecutable ? ["--flowweave-graph-smoke-test"] : [appRoot, "--flowweave-graph-smoke-test"], {
      env: {
        ...process.env,
        PATH: emptyToolchainPath,
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_RENDERER_URL: process.env.FLOWWEAVE_GRAPH_SMOKE_RENDERER_URL,
        FLOWWEAVE_GRAPH_SMOKE_PROJECT: projectPath,
        FLOWWEAVE_GRAPH_SMOKE_SECOND_PROJECT: secondProjectPath,
        FLOWWEAVE_GRAPH_SMOKE_USER_DATA: userDataPath,
        FLOWWEAVE_GRAPH_SMOKE_REPORT: reportPath,
        FLOWWEAVE_GRAPH_SMOKE_EXPECT: expected,
        FLOWWEAVE_GRAPH_SMOKE_SCREENSHOT: screenshotBasePath
          ? screenshotBasePath.replace(/\.png$/i, `-${expected}.png`)
          : undefined
      },
      stdio: "inherit",
      windowsHide: true
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Graph smoke fixture ${expected} exceeded 90 seconds.`)); }, 90_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveResult();
      else reject(new Error(`Graph smoke fixture ${expected} failed: exit=${code ?? "none"} signal=${signal ?? "none"}.`));
    });
  });
}

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const appRoot = process.cwd();
const packagedExecutable = process.env.FLOWWEAVE_PACKAGED_EXECUTABLE;
const executable = resolve(packagedExecutable ?? require("electron"));
await access(executable);
if (!packagedExecutable) await access(join(appRoot, "out", "main", "index.js"));

for (const fixture of ["edges", "empty", "four-languages"]) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `flowweave-graph-smoke-${fixture}-`));
  try {
    const projectPath = join(temporaryRoot, "project");
    const userDataPath = join(temporaryRoot, "user-data");
    const emptyToolchainPath = join(temporaryRoot, "no-toolchain");
    const reportPath = join(temporaryRoot, "rendered-graph.json");
    await mkdir(userDataPath, { recursive: true });
    await mkdir(emptyToolchainPath);
    await createFixture(projectPath, fixture);
    await runElectron(projectPath, userDataPath, emptyToolchainPath, reportPath, fixture);
    const index = await readArtifact(join(projectPath, ".flowweave", "index", "semantic-index.json"));
    const architecture = await readArtifact(join(projectPath, ".flowweave", "architecture-map.json"));
    const canvas = await readArtifact(join(projectPath, ".flowweave", "canvas", "main.canvas.json"));
    const rendered = await readArtifact(reportPath);
    if (index.version !== 5 || architecture.version !== 3) throw new Error(`Graph smoke artifact versions are stale: semantic=${index.version} architecture=${architecture.version}`);
    if (index.diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new Error(`Graph smoke analysis failed: ${JSON.stringify(index.diagnostics)}`);
    if (canvas.layout.viewMode !== "architecture" || rendered.viewMode !== "architecture") throw new Error(`Graph smoke fixture ${fixture} must open the architecture overview.`);
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
    if (fixture === "four-languages") {
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
    if (fixture !== "empty") {
      if (!rendered.edges.length) throw new Error(`Graph smoke fixture ${fixture} rendered no ReactFlow edges.`);
      for (const edge of canvas.edges) checkRenderedEdge(rendered, edge);
    } else if (rendered.edges.length) throw new Error("Empty graph smoke rendered invented edges.");
    console.log(`Graph smoke artifacts verified: ${fixture}; semantic=v${index.version}; architecture=v${architecture.version}; ReactFlow edges=${rendered.edges.length}; toolchain PATH empty.`);
    if (fixture === "edges") {
      await verifyPackagedConcurrency(projectPath, temporaryRoot, emptyToolchainPath);
      const [latestCanvas, latestIndex, latestArchitecture] = await Promise.all([
        readArtifact(join(projectPath, ".flowweave", "canvas", "main.canvas.json")),
        readArtifact(join(projectPath, ".flowweave", "index", "semantic-index.json")),
        readArtifact(join(projectPath, ".flowweave", "architecture-map.json"))
      ]);
      await verifyLegacyRestore(projectPath, temporaryRoot, emptyToolchainPath, latestCanvas, latestIndex, latestArchitecture);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
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
  if (newerResult.status !== "committed" || olderResult.status !== "superseded" || committed.requestId !== newerResult.generation?.requestId) {
    throw new Error(`Packaged cross-process request ordering failed: ${JSON.stringify({ olderResult, newerResult, committed })}.`);
  }
  const root = join(projectPath, ".flowweave");
  const artifactPaths = [
    "project.json", "architecture-local.json", "architecture-map.json", "canvas/main.canvas.json",
    "tasks/current.task.json", "modification-baseline.json", "index/manifest.json", "index/semantic-index.json"
  ];
  const artifacts = await Promise.all(artifactPaths.map((path) => readArtifact(join(root, path))));
  const fileCachePaths = await readdir(join(root, "index/files"));
  for (const path of fileCachePaths) artifacts.push(await readArtifact(join(root, "index/files", path)));
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.generation?.requestId !== newerResult.generation.requestId || artifact.generation?.inputFingerprint !== newerResult.generation.inputFingerprint) {
      throw new Error(`Packaged generation artifact ${artifactPaths[index] ?? `index/files/${fileCachePaths[index - artifactPaths.length]}`} has a mismatched identity.`);
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

async function verifyLegacyRestore(projectPath, temporaryRoot, emptyToolchainPath, currentCanvas, currentIndex, currentArchitecture) {
  const canvasPath = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
  const legacyCanvas = { ...currentCanvas, version: 5 };
  await writeFile(canvasPath, `${JSON.stringify(legacyCanvas, null, 2)}\n`, "utf8");
  const legacyBytes = await readFile(canvasPath);
  await writeFile(join(projectPath, "frontend", "tsconfig.json"), "{ broken", "utf8");
  const reportPath = join(temporaryRoot, "legacy-rendered-graph.json");
  await runElectron(projectPath, join(temporaryRoot, "legacy-user-data"), emptyToolchainPath, reportPath, "legacy");
  const [afterCanvas, afterIndex, afterArchitecture, rendered] = await Promise.all([
    readFile(canvasPath),
    readArtifact(join(projectPath, ".flowweave", "index", "semantic-index.json")),
    readArtifact(join(projectPath, ".flowweave", "architecture-map.json")),
    readArtifact(reportPath)
  ]);
  if (!afterCanvas.equals(legacyBytes)) throw new Error("Packaged failed rescan modified the legacy v5 Canvas.");
  if (afterIndex.generation?.requestId !== currentIndex.generation?.requestId || afterArchitecture.generation?.requestId !== currentArchitecture.generation?.requestId) {
    throw new Error("Packaged failed legacy rescan changed a previously committed generation.");
  }
  if (rendered.nodes < 2 || !/v5/i.test(rendered.projectStatus) || !/(rescan failed|重新扫描失败)/i.test(rendered.projectStatus) || rendered.readOnlyActionCount < 2 || !rendered.readOnlyActionsDisabled) {
    throw new Error(`Packaged app did not preserve and show the failed-rescan legacy Canvas read-only: ${JSON.stringify(rendered)}.`);
  }
  console.log(`Packaged legacy restore verified: nodes=${rendered.nodes}; failed rescan retained v5 Canvas bytes and committed generation; mutation actions disabled.`);
}

async function readArtifact(path) {
  return JSON.parse(await readFile(path, "utf8"));
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
    ["filesystem", "/flowweave-graph-smoke/fixture.txt", "filesystem", "read", "reads_writes"],
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
    const edge = canvas.edges.find((item) => item.source === source && item.target === target && item.relation === relationKind && item.sourceRelationIds?.includes(fact.id));
    if (!edge || !canvas.nodes.some((node) => node.id === resource.id && node.resource?.id === resource.id)) throw new Error(`Graph smoke missing canonical ${relationKind} edge ${source} -> ${target}`);
    checkRenderedEdge(rendered, edge);
  }
}

function checkRenderedEdge(rendered, edge) {
  const actual = rendered.edges.find((item) => item.id === edge.id);
  if (!actual || !actual.path || /NaN|Infinity/.test(actual.path) || !actual.markerEnd || actual.label !== `Edge from ${edge.source} to ${edge.target}` || !rendered.nodeIds.includes(edge.source) || !rendered.nodeIds.includes(edge.target)) throw new Error(`Graph smoke missing directed ReactFlow SVG edge: ${JSON.stringify({ expected: edge, actual })}`);
}

async function createFixture(projectPath, fixture) {
  if (fixture === "four-languages") {
    await cp(join(appRoot, "tests", "fixtures", "four-language-workspace"), projectPath, { recursive: true });
    await writeFile(join(projectPath, "plugin/packages/dashboard/src/resources.ts"), "import { readFile } from 'node:fs/promises';\nimport { EventEmitter } from 'node:events';\nexport const emitter = new EventEmitter();\nexport function inspect() {\n  readFile('/flowweave-graph-smoke/fixture.txt');\n  fetch('https://fixture.flowweave.invalid/v1/users', { method: 'POST' });\n  emitter.emit('graph-smoke-ready');\n}\n");
    await writeFile(join(projectPath, "plugin/packages/dashboard/src/resource-observer.ts"), "import { emitter } from './resources';\nexport function observe() { emitter.on('graph-smoke-ready', () => {}); }\n");
    return;
  }
  const accounts = join(projectPath, "src", "features", "accounts", "account.service.ts");
  const orders = join(projectPath, "src", "features", "orders", "order.service.ts");
  await mkdir(dirname(accounts), { recursive: true });
  await mkdir(dirname(orders), { recursive: true });
  await writeFile(accounts, fixture === "edges"
    ? 'import { loadOrder } from "../orders/order.service";\nexport function loadAccount() { return loadOrder(); }\n'
    : "export function loadAccount() { return 1; }\n", "utf8");
  await writeFile(orders, "export function loadOrder() { return 2; }\n", "utf8");
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

function runElectron(projectPath, userDataPath, emptyToolchainPath, reportPath, expected) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, packagedExecutable ? ["--flowweave-graph-smoke-test"] : [appRoot, "--flowweave-graph-smoke-test"], {
      env: {
        ...process.env,
        PATH: emptyToolchainPath,
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_RENDERER_URL: undefined,
        FLOWWEAVE_GRAPH_SMOKE_PROJECT: projectPath,
        FLOWWEAVE_GRAPH_SMOKE_USER_DATA: userDataPath,
        FLOWWEAVE_GRAPH_SMOKE_REPORT: reportPath,
        FLOWWEAVE_GRAPH_SMOKE_EXPECT: expected
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

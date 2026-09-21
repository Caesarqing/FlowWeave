import { createHash } from "node:crypto";
import type {
  ArchitectureModule,
  ArchitectureModuleCategory,
  FileInsight,
  ModuleIdentity,
  ModuleClusteringDiagnostic,
  SemanticRelation
} from "../../types";

const FUNCTIONAL_DIRECTORY_MARKERS = new Set(["features", "modules", "domains"]);
const INTEGRATION_DIRECTORY_MARKERS = new Set(["integration", "integrations", "external"]);
const GENERIC_DIRECTORIES = new Set([
  "api", "app", "apps", "components", "config", "contexts", "data", "domain", "external",
  "features", "hooks", "integration", "integrations", "main", "modules", "nodes", "pages",
  "renderer", "repositories", "repository", "routes", "service", "services", "shared", "src",
  "storage", "stores", "utils", "utilities", "views", "workers", "worker", "common", "helpers"
]);
const GENERIC_NAMES = new Set(["app", "common", "constants", "helpers", "index", "main", "module", "shared", "types", "util", "utils"]);
const SUPPORT_SUFFIXES = new Set(["helper", "helpers", "util", "utils", "utility", "utilities"]);
const RESPONSIBILITY_SUFFIXES = new Set([
  "adapter", "api", "client", "component", "controller", "gateway", "hook", "ipc", "page",
  "panel", "repo", "repository", "route", "router", "service", "store", "util", "utils",
  "utility", "utilities", "helper", "helpers", "worker", "workspace"
]);
const RELATION_KINDS = new Set<SemanticRelation["kind"]>(["call", "render", "database", "filesystem", "event"]);
const MAX_MODULE_SOURCE_FILES = 20;

type ClusterSeedKind = "feature" | "test" | "external" | "responsibility" | "support" | "unknown";

type ClusterSeed = {
  key: string;
  kind: ClusterSeedKind;
  name: string;
  anchorDirectory?: string;
  responsibility?: string;
};

type ModuleCluster = {
  id: string;
  title: string;
  category: ArchitectureModuleCategory;
  files: string[];
  identity: ModuleIdentity;
};

export type ModuleClusteringResult = {
  modules: ModuleCluster[];
  diagnostics: ModuleClusteringDiagnostic[];
};

export function clusterArchitectureModules(
  files: FileInsight[],
  relations: SemanticRelation[],
  previousModules: ArchitectureModule[]
): ModuleClusteringResult {
  const sortedFiles = [...new Map(files.map((file) => [file.path, file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const filePaths = new Set(sortedFiles.map((file) => file.path));
  const relevantRelations = sortRelations(relations.filter((relation) =>
    relation.confidence === "confirmed" &&
    RELATION_KINDS.has(relation.kind) &&
    filePaths.has(relation.sourceFile) &&
    Boolean(relation.targetFile && filePaths.has(relation.targetFile))
  ));
  const seedByFile = new Map(sortedFiles.map((file) => [file.path, seedForFile(file.path)]));
  const groupByFile = new Map([...seedByFile].map(([path, seed]) => [path, seed.key]));
  const supportReferences = supportDomainReferences(seedByFile, relevantRelations);

  for (const [path, seed] of seedByFile) {
    if (seed.kind === "support" && (supportReferences.get(path)?.size ?? 0) >= 3) {
      groupByFile.set(path, "shared:utilities");
    }
  }
  mergeRelatedSingletons(seedByFile, groupByFile, relevantRelations);
  attachUniquelyRelatedUnknownFiles(seedByFile, groupByFile, relevantRelations);

  const filesByGroup = groupFiles(sortedFiles, groupByFile);
  const clusters = [...filesByGroup.entries()].map(([key, clusterFiles]) => {
    const seed = [...seedByFile.values()].find((candidate) => candidate.key === key) ?? unknownSeed(clusterFiles[0].path);
    const kind = key === "shared:utilities" ? "shared" : seed.kind;
    const title = titleForGroup(kind, seed.name);
    const anchor = anchorForGroup(kind, seed, clusterFiles.map((file) => file.path));
    const clusterFingerprint = createClusterFingerprint(clusterFiles.map((file) => file.path), relevantRelations);
    const predecessors = predecessorModules(clusterFiles.map((file) => file.path), previousModules);
    const id = moduleIdForAnchor(anchor);
    const predecessorIds = predecessors
      .filter((module) => predecessors.length > 1 || module.id !== id)
      .map((module) => module.id)
      .sort();
    return {
      id,
      title,
      category: categoryForGroup(kind, clusterFiles, seedByFile),
      files: clusterFiles.map((file) => file.path),
      identity: { id, anchor, clusterFingerprint, predecessorIds },
      previousIds: predecessors.map((module) => module.id).sort()
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const diagnostics = clusteringDiagnostics(clusters, previousModules);
  return { modules: clusters.map(({ previousIds: _previousIds, ...cluster }) => cluster), diagnostics };
}

function seedForFile(path: string): ClusterSeed {
  const normalizedPath = normalizePath(path);
  const segments = normalizedPath.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__") || /\.(test|spec)\.[^.]+$/.test(normalizedPath)) {
    return { key: "tests", kind: "test", name: "tests", anchorDirectory: "tests" };
  }

  const featureIndex = lowerSegments.findIndex((segment) => FUNCTIONAL_DIRECTORY_MARKERS.has(segment));
  if (featureIndex >= 0 && segments[featureIndex + 1]) {
    const feature = normalizeName(segments[featureIndex + 1]);
    const anchorDirectory = normalizePath(segments.slice(featureIndex, featureIndex + 2).join("/"));
    return { key: `feature:${feature}`, kind: "feature", name: feature, anchorDirectory };
  }

  const integrationIndex = lowerSegments.findIndex((segment) => INTEGRATION_DIRECTORY_MARKERS.has(segment));
  const stem = responsibilityStem(segments.at(-1) ?? "");
  if (integrationIndex >= 0) {
    const integration = segments[integrationIndex + 1]
      ? normalizeName(segments[integrationIndex + 1])
      : stem;
    const anchorDirectory = normalizePath(segments.slice(integrationIndex, integrationIndex + 2).join("/"));
    return { key: `external:${integration}`, kind: "external", name: integration, anchorDirectory };
  }

  const parentSegments = lowerSegments.slice(0, -1);
  const supportDirectory = parentSegments.find((segment) => segment === "shared" || segment === "common" || segment === "utils" || segment === "utilities" || segment === "helpers");
  const supportName = stem && !GENERIC_NAMES.has(stem) ? stem : undefined;
  if (!hasSpecificResponsibilitySuffix(segments.at(-1) ?? "") &&
      (supportDirectory || SUPPORT_SUFFIXES.has(filenameSuffix(segments.at(-1) ?? "")))) {
    const name = supportName ?? "unknown";
    return { key: `support:${name}`, kind: "support", name, responsibility: name };
  }

  if (stem && !GENERIC_NAMES.has(stem)) {
    return { key: `responsibility:${stem}`, kind: "responsibility", name: stem, responsibility: stem };
  }

  const functionalDirectory = [...segments.slice(0, -1)].reverse()
    .find((segment) => !GENERIC_DIRECTORIES.has(segment.toLowerCase()) && !GENERIC_NAMES.has(normalizeName(segment)));
  if (functionalDirectory) {
    const name = normalizeName(functionalDirectory);
    return { key: `responsibility:${name}`, kind: "responsibility", name, responsibility: name };
  }

  return unknownSeed(normalizedPath);
}

function hasSpecificResponsibilitySuffix(filename: string): boolean {
  const suffix = filenameSuffix(filename);
  return RESPONSIBILITY_SUFFIXES.has(suffix) && !SUPPORT_SUFFIXES.has(suffix);
}

function filenameSuffix(filename: string): string {
  const basename = filename.split("/").at(-1) ?? filename;
  const noExtension = basename.replace(/\.[^.]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  return normalizeName(noExtension).split("-").at(-1) ?? "";
}

function unknownSeed(path: string): ClusterSeed {
  const parentPath = normalizePath(path).split("/").slice(0, -1).join("/");
  return {
    key: `unknown:${parentPath || normalizePath(path)}`,
    kind: "unknown",
    name: "unknown",
    anchorDirectory: parentPath || undefined
  };
}

function supportDomainReferences(
  seedByFile: Map<string, ClusterSeed>,
  relations: SemanticRelation[]
): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (!relation.targetFile) continue;
    const targetSeed = seedByFile.get(relation.targetFile);
    const sourceSeed = seedByFile.get(relation.sourceFile);
    if (targetSeed?.kind !== "support" || !sourceSeed || (sourceSeed.kind !== "feature" && sourceSeed.kind !== "responsibility")) continue;
    const domains = references.get(relation.targetFile) ?? new Set<string>();
    domains.add(sourceSeed.key);
    references.set(relation.targetFile, domains);
  }
  return references;
}

function attachUniquelyRelatedUnknownFiles(
  seedByFile: Map<string, ClusterSeed>,
  groupByFile: Map<string, string>,
  relations: SemanticRelation[]
): void {
  const assignments = new Map<string, string>();
  for (const [path, seed] of seedByFile) {
    if (seed.kind !== "unknown") continue;
    const neighboringGroups = new Set<string>();
    for (const relation of relations) {
      if (relation.sourceFile === path && relation.targetFile) {
        addAttachableGroup(neighboringGroups, groupByFile.get(relation.targetFile), seedByFile.get(relation.targetFile));
      }
      if (relation.targetFile === path) {
        addAttachableGroup(neighboringGroups, groupByFile.get(relation.sourceFile), seedByFile.get(relation.sourceFile));
      }
    }
    if (neighboringGroups.size === 1) assignments.set(path, [...neighboringGroups][0]);
  }
  assignments.forEach((group, path) => groupByFile.set(path, group));
}

function mergeRelatedSingletons(
  seedByFile: Map<string, ClusterSeed>,
  groupByFile: Map<string, string>,
  relations: SemanticRelation[]
): void {
  const candidateGroups = [...new Set(groupByFile.values())].sort();
  for (const candidateGroup of candidateGroups) {
    const candidatePaths = [...groupByFile.entries()]
      .filter(([, group]) => group === candidateGroup)
      .map(([path]) => path)
      .sort();
    if (candidatePaths.length !== 1) continue;
    const candidatePath = candidatePaths[0];
    const candidateSeed = seedByFile.get(candidatePath);
    if (!candidateSeed || candidateSeed.kind !== "responsibility" || boundaryPriority(candidatePath) < Number.MAX_SAFE_INTEGER) continue;

    const scores = new Map<string, number>();
    for (const relation of relations) {
      if (relation.targetFile !== candidatePath) continue;
      const sourcePath = relation.sourceFile;
      const sourceGroup = groupByFile.get(sourcePath);
      const sourceSeed = seedByFile.get(sourcePath);
      if (!sourceGroup || sourceGroup === candidateGroup || !sourceSeed ||
          (sourceSeed.kind !== "feature" && sourceSeed.kind !== "responsibility")) continue;
      scores.set(sourceGroup, (scores.get(sourceGroup) ?? 0) + relationStrength(relation.kind));
    }
    const strongest = [...scores.entries()].sort(([leftGroup, leftScore], [rightGroup, rightScore]) =>
      rightScore - leftScore || leftGroup.localeCompare(rightGroup)
    )[0];
    if (strongest && strongest[1] > 0) groupByFile.set(candidatePath, strongest[0]);
  }
}

function relationStrength(kind: SemanticRelation["kind"]): number {
  if (kind === "call" || kind === "render") return 3;
  if (kind === "event") return 2;
  return 1;
}

function addAttachableGroup(groups: Set<string>, group: string | undefined, seed: ClusterSeed | undefined): void {
  if (!group || !seed || seed.kind === "unknown" || seed.kind === "support" || seed.kind === "test") return;
  groups.add(group);
}

function groupFiles(files: FileInsight[], groupByFile: Map<string, string>): Map<string, FileInsight[]> {
  const groups = new Map<string, FileInsight[]>();
  for (const file of files) {
    const key = groupByFile.get(file.path);
    if (!key) throw new Error(`Module clustering did not assign a source file: ${file.path}`);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const sortedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, members]) => [key, members.sort((left, right) => left.path.localeCompare(right.path))] as const);
  return new Map(sortedGroups);
}

function categoryForGroup(
  kind: ClusterSeedKind | "shared",
  files: FileInsight[],
  seedByFile: Map<string, ClusterSeed>
): ArchitectureModuleCategory {
  if (kind === "test") return "test-surface";
  if (kind === "external") return "external-integration";
  if (kind === "shared") return "shared-utility";
  if (kind === "unknown" || kind === "support") return "unknown";
  const counts = new Map<ArchitectureModuleCategory, number>();
  for (const file of files) {
    const category = categoryForFile(file.path, seedByFile.get(file.path));
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftCategory, leftCount], [rightCategory, rightCount]) =>
      rightCount - leftCount || categoryRank(leftCategory) - categoryRank(rightCategory) || leftCategory.localeCompare(rightCategory)
    )[0]?.[0] ?? "unknown";
}

function categoryForFile(path: string, seed: ClusterSeed | undefined): ArchitectureModuleCategory {
  const lowerPath = path.toLowerCase();
  const filename = path.split("/").at(-1) ?? "";
  const name = `${responsibilityStem(filename)}-${filenameSuffix(filename)}`;
  if (/\/(test|tests|__tests__)\//.test(`/${lowerPath}/`) || /\.(test|spec)\.[^.]+$/.test(lowerPath)) return "test-surface";
  if (seed?.kind === "external") return "external-integration";
  if (/worker|queue|consumer|cron|scheduler/.test(name) || /\/(worker|workers|jobs)\//.test(`/${lowerPath}/`)) return "job-worker";
  if (/repository|repo|database|migration|schema/.test(name) || /\/(storage|data|database)\//.test(`/${lowerPath}/`)) return "data-access";
  if (/controller|route|router|endpoint|ipc|gateway/.test(name) || /\/(api|routes|ipc)\//.test(`/${lowerPath}/`)) return "api-boundary";
  if (seed?.kind === "unknown") return "unknown";
  return "domain-service";
}

function categoryRank(category: ArchitectureModuleCategory): number {
  const ranks: Record<ArchitectureModuleCategory, number> = {
    "domain-service": 0,
    "api-boundary": 1,
    "data-access": 2,
    "job-worker": 3,
    "external-integration": 4,
    "shared-utility": 5,
    "test-surface": 6,
    "unknown": 7
  };
  return ranks[category];
}

function titleForGroup(kind: ClusterSeedKind | "shared", name: string): string {
  if (kind === "test") return "Tests";
  if (kind === "shared") return "Shared Utilities";
  if (kind === "unknown" || kind === "support") return "Unknown";
  if (kind === "external") return `${titleFromName(name)} Integration`;
  return titleFromName(name);
}

function anchorForGroup(kind: ClusterSeedKind | "shared", seed: ClusterSeed, paths: string[]): string {
  const boundaryFiles = paths
    .filter((path) => boundaryPriority(path) < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => boundaryPriority(left) - boundaryPriority(right) || left.localeCompare(right));
  if (boundaryFiles[0]) return `file:${normalizePath(boundaryFiles[0])}`;
  if (kind === "feature") return `directory:${seed.anchorDirectory ?? seed.name}`;
  if (kind === "test") return "directory:tests";
  if (kind === "shared") return "directory:shared-utilities";
  if (kind === "external") return `directory:${seed.anchorDirectory ?? seed.name}`;
  if (kind === "responsibility") return `responsibility:${seed.responsibility ?? seed.name}`;
  if (kind === "unknown") return seed.anchorDirectory ? `directory:${seed.anchorDirectory}` : `file:${normalizePath(paths[0])}`;
  return `directory:${seed.name}`;
}

function boundaryPriority(path: string): number {
  const lowerPath = path.toLowerCase();
  const priorities = [
    /(^|\/)entry[^/]*\.[^.]+$/,
    /(^|\/)(route|router)[^/]*\.[^.]+$/,
    /(^|\/)[^/]*\.ipc\.[^.]+$/,
    /(^|\/)[^/]*controller\.[^.]+$/,
    /(^|\/)[^/]*worker\.[^.]+$/,
    /(^|\/)[^/]*(repository|repo)\.[^.]+$/,
    /(^|\/)[^/]*adapter\.[^.]+$/
  ];
  const index = priorities.findIndex((pattern) => pattern.test(lowerPath));
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function createClusterFingerprint(paths: string[], relations: SemanticRelation[]): string {
  const pathSet = new Set(paths);
  const relationKeys = relations
    .filter((relation) => pathSet.has(relation.sourceFile) || Boolean(relation.targetFile && pathSet.has(relation.targetFile)))
    .map((relation) => [relation.kind, relation.sourceFile, relation.targetFile, relation.symbol ?? "", relation.detail])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return hash(JSON.stringify({ files: [...paths].sort(), relations: relationKeys }));
}

function predecessorModules(paths: string[], previousModules: ArchitectureModule[]): ArchitectureModule[] {
  const currentPaths = new Set(paths);
  return previousModules
    .filter((module) => module.files.some((path) => currentPaths.has(path)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function clusteringDiagnostics(
  clusters: Array<ModuleCluster & { previousIds: string[] }>,
  previousModules: ArchitectureModule[]
): ModuleClusteringDiagnostic[] {
  const diagnostics: ModuleClusteringDiagnostic[] = [];
  for (const cluster of clusters) {
    if (cluster.category === "unknown") {
      diagnostics.push({
        code: "unknown-files",
        moduleIds: [cluster.id],
        filePaths: cluster.files,
        message: "These files could not be assigned to a functional module from the available static evidence."
      });
    }
    if (cluster.files.length > MAX_MODULE_SOURCE_FILES) {
      diagnostics.push({
        code: "oversized-module",
        moduleIds: [cluster.id],
        filePaths: cluster.files,
        message: `Module contains ${cluster.files.length} source files; review its responsibility boundaries before splitting it.`
      });
    }
    if (cluster.previousIds.length > 1) {
      diagnostics.push({
        code: "lineage-merge",
        moduleIds: [cluster.id],
        filePaths: cluster.files,
        message: `This module consolidates previous modules: ${cluster.previousIds.join(", ")}.`
      });
    }
  }

  for (const previous of previousModules) {
    const currentIds = clusters
      .filter((cluster) => previous.files.some((path) => cluster.files.includes(path)))
      .map((cluster) => cluster.id)
      .sort();
    if (currentIds.length > 1) {
      diagnostics.push({
        code: "lineage-split",
        moduleIds: currentIds,
        filePaths: previous.files.filter((path) => clusters.some((cluster) => cluster.files.includes(path))).sort(),
        message: `Previous module ${previous.id} now spans multiple functional modules.`
      });
    }
  }

  return diagnostics.sort((left, right) =>
    left.code.localeCompare(right.code) || left.moduleIds.join("\u0000").localeCompare(right.moduleIds.join("\u0000")) ||
    left.filePaths.join("\u0000").localeCompare(right.filePaths.join("\u0000"))
  );
}

function sortRelations(relations: SemanticRelation[]): SemanticRelation[] {
  return [...relations].sort((left, right) =>
    left.sourceFile.localeCompare(right.sourceFile) || (left.targetFile ?? "").localeCompare(right.targetFile ?? "") ||
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  );
}

function responsibilityStem(filename: string): string {
  const basename = filename.split("/").at(-1) ?? filename;
  const noExtension = basename.replace(/\.[^.]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  const normalized = normalizeName(noExtension);
  const parts = normalized.split("-");
  while (parts.length > 0 && RESPONSIBILITY_SUFFIXES.has(parts.at(-1) ?? "")) parts.pop();
  return parts.join("-");
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function titleFromName(name: string): string {
  return name.split(/[-_/]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ") || "Unknown";
}

function moduleIdForAnchor(anchor: string): string {
  return `module-${hash(normalizePath(anchor).toLowerCase()).slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import { createHash } from "node:crypto";
import type { SemanticHttpEndpoint, SemanticRelation } from "../../types";

export function buildCrossStackHttpRelations(endpoints: SemanticHttpEndpoint[]): SemanticRelation[] {
  const requests = endpoints.filter((endpoint) => endpoint.kind === "request");
  const routes = endpoints.filter((endpoint) => endpoint.kind === "route");
  const relations: SemanticRelation[] = [];
  for (const request of requests) {
    for (const route of routes) {
      if (!methodsMatch(request, route) || !pathsMatch(request.path, route.path)) continue;
      const confidence = request.confidence === "confirmed" && route.confidence === "confirmed" ? "confirmed" : "inferred";
      relations.push({
        id: createHash("sha256")
          .update(`http\0${request.filePath}\0${route.filePath}\0${request.method}\0${request.path}`)
          .digest("hex")
          .slice(0, 24),
        kind: "http",
        source: request.filePath,
        target: route.filePath,
        sourceFile: request.filePath,
        targetFile: route.filePath,
        symbol: request.symbol,
        detail: `${request.method} ${request.path} matches backend route ${route.method} ${route.path}`,
        confidence
      });
    }
  }
  return relations;
}

function methodsMatch(request: SemanticHttpEndpoint, route: SemanticHttpEndpoint): boolean {
  return request.method === route.method || request.method === "UNKNOWN" || route.method === "UNKNOWN";
}

function pathsMatch(requestPath: string, routePath: string): boolean {
  const requestSegments = normalizeSegments(requestPath);
  const routeSegments = normalizeSegments(routePath);
  if (requestSegments.length !== routeSegments.length) return false;
  return requestSegments.every((segment, index) => {
    const candidate = routeSegments[index];
    return isParameter(segment) || isParameter(candidate) || segment === candidate;
  });
}

function normalizeSegments(path: string): string[] {
  const pathOnly = path.split("?")[0] ?? path;
  return pathOnly.split("/").filter(Boolean);
}

function isParameter(segment: string | undefined): boolean {
  return Boolean(segment && (
    segment.startsWith(":") ||
    (segment.startsWith("{") && segment.endsWith("}")) ||
    (segment.startsWith("${") && segment.endsWith("}"))
  ));
}

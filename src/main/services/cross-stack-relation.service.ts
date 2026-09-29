import { createHash } from "node:crypto";
import type { SemanticHttpEndpoint, SemanticRelation } from "../../types";

export function buildCrossStackHttpRelations(endpoints: SemanticHttpEndpoint[]): SemanticRelation[] {
  const requests = endpoints.filter((endpoint) => endpoint.kind === "request");
  const routes = endpoints.filter((endpoint) => endpoint.kind === "route");
  const relations: SemanticRelation[] = [];
  for (const request of requests) {
    const candidates = routes.filter((route) => methodsMatch(request, route) && pathsMatch(request.path, route.path) && sameService(request, route));
    if (candidates.length !== 1) continue;
    for (const route of candidates) {
      const confidence = request.confidence === "confirmed" && route.confidence === "confirmed" ? "confirmed" : "inferred";
      relations.push({
        id: createHash("sha256")
          .update(`http\0${request.id}\0${route.id}`)
          .digest("hex")
          .slice(0, 24),
        kind: "http",
        source: request.filePath,
        target: route.filePath,
        sourceFile: request.filePath,
        targetFile: route.filePath,
        symbol: request.symbol,
        detail: `${request.method} ${request.path} matches backend route ${route.method} ${route.path}`,
        confidence, sourceRange: request.range,
        targetRef: { kind: "file", filePath: route.filePath, declarationRange: route.range },
        bindingBasis: request.serviceId ? "unique-service-mapping" : "unique-origin-mapping"
      });
    }
  }
  return relations;
}

function sameService(request: SemanticHttpEndpoint, route: SemanticHttpEndpoint): boolean {
  if (request.serviceId && route.serviceId) return request.serviceId === route.serviceId;
  return Boolean(request.origin && route.origin && request.origin === route.origin);
}

function methodsMatch(request: SemanticHttpEndpoint, route: SemanticHttpEndpoint): boolean {
  return request.method !== "UNKNOWN" && request.method === route.method;
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

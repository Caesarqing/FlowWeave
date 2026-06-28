import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRunTarget, ExecutionMode, RuntimeAgentId, ToolRunPurpose } from "../../types";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export type DesktopBridgeRequestStatus = "pending" | "completed" | "failed";

export type DesktopBridgePendingRequest = {
  runId: string;
  projectId: string;
  agentId: RuntimeAgentId;
  purpose: ToolRunPurpose;
  executionMode: ExecutionMode;
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  reviewId?: string;
  createdAt: string;
  requestPath: string;
  responsePath: string;
  status: DesktopBridgeRequestStatus;
};

export type DesktopBridgePendingManifest = {
  version: 1;
  updatedAt: string;
  requests: DesktopBridgePendingRequest[];
};

const manifestWriteQueues = new Map<string, Promise<void>>();

export function desktopBridgeManifestPath(projectPath: string): string {
  return join(projectPath, FLOWWEAVE_DIR, "agent-bridge", "pending-requests.json");
}

export async function addDesktopBridgePendingRequest(
  projectPath: string,
  request: DesktopBridgePendingRequest
): Promise<void> {
  await updateDesktopBridgePendingManifest(projectPath, (manifest) => {
    const requests = manifest.requests.filter((entry) => entry.runId !== request.runId);
    requests.push(request);
    requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { ...manifest, requests };
  });
}

export async function markDesktopBridgeRequestStatus(
  projectPath: string,
  runId: string,
  status: DesktopBridgeRequestStatus
): Promise<void> {
  await updateDesktopBridgePendingManifest(projectPath, (manifest) => ({
    ...manifest,
    requests: manifest.requests.map((request) => request.runId === runId ? { ...request, status } : request)
  }));
}

export async function readDesktopBridgePendingManifest(projectPath: string): Promise<DesktopBridgePendingManifest> {
  const value = await readJsonArtifact(desktopBridgeManifestPath(projectPath));
  if (!isDesktopBridgePendingManifest(value)) {
    return emptyManifest();
  }
  return value;
}

async function updateDesktopBridgePendingManifest(
  projectPath: string,
  update: (manifest: DesktopBridgePendingManifest) => DesktopBridgePendingManifest
): Promise<void> {
  const manifestPath = desktopBridgeManifestPath(projectPath);
  const previous = manifestWriteQueues.get(manifestPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(manifestPath), { recursive: true });
    const next = {
      ...update(await readDesktopBridgePendingManifest(projectPath)),
      version: 1 as const,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(manifestPath, next);
  });
  manifestWriteQueues.set(manifestPath, current);
  try {
    await current;
  } finally {
    if (manifestWriteQueues.get(manifestPath) === current) {
      manifestWriteQueues.delete(manifestPath);
    }
  }
}

function emptyManifest(): DesktopBridgePendingManifest {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    requests: []
  };
}

function isDesktopBridgePendingManifest(value: unknown): value is DesktopBridgePendingManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DesktopBridgePendingManifest>;
  return candidate.version === 1 && Array.isArray(candidate.requests);
}

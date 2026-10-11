import type { GenerationIdentity } from "../../types";

export class GenerationSupersededError extends Error {
  constructor(projectPath: string, requestId: string, latestRequestId: string) {
    super(`Generation superseded: project ${projectPath}, request ${requestId}, latest request ${latestRequestId}`);
    this.name = "GenerationSupersededError";
  }
}
export class GenerationInputChangedError extends Error {
  constructor(context: string) { super(`Generation input changed: ${context}`); this.name = "GenerationInputChangedError"; }
}
export class ArtifactGenerationMismatchError extends Error {
  constructor(projectPath: string, artifactPath: string, expected: GenerationIdentity | undefined, actual: GenerationIdentity | undefined) {
    super(`Artifact generation mismatch: project ${projectPath}, artifact ${artifactPath}, expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
    this.name = "ArtifactGenerationMismatchError";
  }
}
export class ArtifactLockOccupiedError extends Error {
  constructor(projectPath: string, pid: number, ownerId: string) {
    super(`Artifact lock occupied for project ${projectPath}: owner PID ${pid}, UUID ${ownerId}; wait limit 30000ms`);
    this.name = "ArtifactLockOccupiedError";
  }
}
export class TransactionRecoveryError extends Error {
  constructor(projectPath: string, context: string, cause: unknown) {
    super(`Transaction recovery failed for project ${projectPath}; ${context}: ${String(cause)}`, { cause });
    this.name = "TransactionRecoveryError";
  }
}

export class LegacyCanvasMigrationRequiredError extends Error {
  constructor(projectPath: string, artifactPath: string, version: number, backupPath: string) {
    super(`Legacy Canvas v${version} requires one-time migration and was preserved: project ${projectPath}, artifact ${artifactPath}, backup ${backupPath}`);
    this.name = "LegacyCanvasMigrationRequiredError";
  }
}

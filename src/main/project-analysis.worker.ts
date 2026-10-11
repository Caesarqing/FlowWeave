import type { GenerationPhaseMeasurement, ProjectAnalysisWorkerMessage, ProjectAnalysisWorkerRequest } from "./services/project-generation.service";
import { generateRegisteredProject } from "./services/project-generation.service";
import { isAbsolute } from "node:path";
import { configureTransactionAuthorityRoot } from "./storage/transaction-authority";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Static analysis worker must be launched by Electron utilityProcess.");

parentPort.on("message", ({ data: value }: Electron.MessageEvent) => {
  const data = requireWorkerRequest(value);
  configureTransactionAuthorityRoot(data.transactionAuthorityRoot);
  void generateRegisteredProject(data.request, {
    scanOptions: data.scanOptions,
    onProjectScanned: (scanFingerprint) => parentPort.postMessage({ type: "scanned", requestId: data.request.requestId, scanFingerprint } satisfies ProjectAnalysisWorkerMessage),
    onProgress: (progress) => parentPort.postMessage({ type: "progress", requestId: data.request.requestId, progress } satisfies ProjectAnalysisWorkerMessage),
    ...(data.measurementsEnabled ? {
      onMeasurement: (measurement: GenerationPhaseMeasurement) =>
        parentPort.postMessage({ type: "measurement", requestId: data.request.requestId, measurement } satisfies ProjectAnalysisWorkerMessage)
    } : {})
  }).then((result) => {
    const message: ProjectAnalysisWorkerMessage = result.status === "superseded"
      ? { type: "result", requestId: data.request.requestId, result }
      : {
          type: "result",
          requestId: data.request.requestId,
          result: {
            status: result.status,
            generation: result.generation,
            scanFingerprint: result.project.scanFingerprint ?? "",
            written: result.written,
            localArchitectureInputFingerprint: requireArchitectureFingerprint(result.localArchitecture.metadata?.inputFingerprint, data.request.requestId)
          }
        };
    parentPort.postMessage(message);
  }).catch((error: unknown) => {
    parentPort.postMessage({
      type: "failure",
      requestId: data.request.requestId,
      message: error instanceof Error ? error.message : String(error)
    } satisfies ProjectAnalysisWorkerMessage);
  });
});

function requireWorkerRequest(value: unknown): ProjectAnalysisWorkerRequest {
  if (typeof value !== "object" || value === null || !("request" in value) || typeof value.request !== "object" || value.request === null ||
      !("requestId" in value.request) || typeof value.request.requestId !== "string" || !("projectPath" in value.request) || typeof value.request.projectPath !== "string" ||
      !("measurementsEnabled" in value) || typeof value.measurementsEnabled !== "boolean" ||
      !("transactionAuthorityRoot" in value) || typeof value.transactionAuthorityRoot !== "string" || !isAbsolute(value.transactionAuthorityRoot)) {
    throw new TypeError("Static analysis worker received an invalid project request.");
  }
  return value as ProjectAnalysisWorkerRequest;
}

function requireArchitectureFingerprint(value: string | undefined, requestId: string): string {
  if (!value) throw new Error(`Static architecture output has no input fingerprint for request ${requestId}.`);
  return value;
}

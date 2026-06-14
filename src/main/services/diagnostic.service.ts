import { join } from "node:path";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { redactSensitiveText } from "./sensitive-data.service";

const MAX_DIAGNOSTICS = 100;

export type DiagnosticRecord = {
  id: string;
  timestamp: string;
  category: "scan" | "analysis" | "agent" | "security" | "filesystem" | "internal";
  code: string;
  message: string;
  context: Record<string, string | number | boolean | undefined>;
};

export type DiagnosticInput = Omit<DiagnosticRecord, "id" | "timestamp">;

export async function recordDiagnostic(projectPath: string, input: DiagnosticInput): Promise<DiagnosticRecord> {
  const history = await readDiagnostics(projectPath);
  const record: DiagnosticRecord = {
    ...input,
    id: `diagnostic-${Date.now()}-${history.length}`,
    timestamp: new Date().toISOString(),
    message: redactSensitiveText(input.message),
    context: redactContext(input.context)
  };
  await writeJsonAtomic(historyPath(projectPath), [...history, record].slice(-MAX_DIAGNOSTICS));
  return record;
}

export async function readDiagnostics(projectPath: string): Promise<DiagnosticRecord[]> {
  const value = await readJsonArtifact(historyPath(projectPath));
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isDiagnosticRecord)) {
    throw new Error(`FlowWeave diagnostic history is invalid: ${historyPath(projectPath)}`);
  }
  return value;
}

export async function exportDiagnostics(projectPath: string): Promise<string> {
  const path = join(projectPath, FLOWWEAVE_DIR, "diagnostics", `export-${Date.now()}.json`);
  await writeJsonAtomic(path, {
    version: 1,
    exportedAt: new Date().toISOString(),
    diagnostics: await readDiagnostics(projectPath)
  });
  return path;
}

function historyPath(projectPath: string): string {
  return join(projectPath, FLOWWEAVE_DIR, "diagnostics", "history.json");
}

function redactContext(
  context: DiagnosticInput["context"]
): DiagnosticRecord["context"] {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [
    key,
    typeof value === "string" ? redactSensitiveText(value) : value
  ]));
}

function isDiagnosticRecord(value: unknown): value is DiagnosticRecord {
  return typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "timestamp" in value &&
    typeof value.timestamp === "string" &&
    "category" in value &&
    typeof value.category === "string" &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "context" in value &&
    typeof value.context === "object" &&
    value.context !== null;
}

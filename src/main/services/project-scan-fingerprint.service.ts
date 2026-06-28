import { join } from "node:path";
import { readJsonArtifact } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export async function readCurrentProjectScanFingerprint(projectPath: string): Promise<string> {
  const projectArtifactPath = join(projectPath, FLOWWEAVE_DIR, "project.json");
  const value = await readJsonArtifact(projectArtifactPath);
  if (typeof value !== "object" || value === null || !("scanFingerprint" in value)) {
    throw new Error(`FlowWeave project scan is missing scanFingerprint. Scan the project before starting Agent artifact review: ${projectArtifactPath}`);
  }
  const scanFingerprint = (value as { scanFingerprint?: unknown }).scanFingerprint;
  if (typeof scanFingerprint !== "string" || !scanFingerprint.trim()) {
    throw new Error(`FlowWeave project scan has an invalid scanFingerprint. Rescan the project before starting Agent artifact review: ${projectArtifactPath}`);
  }
  return scanFingerprint;
}

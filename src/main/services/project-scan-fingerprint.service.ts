import { readProjectProtocolSnapshot } from "../storage/flowweave-store";

export async function readCurrentProjectScanFingerprint(projectPath: string): Promise<string> {
  const snapshot = await readProjectProtocolSnapshot(projectPath);
  if (!snapshot) throw new Error(`FlowWeave protocol v7 snapshot is missing. Scan the project before starting Agent artifact review: ${projectPath}`);
  const scanFingerprint = snapshot.project.scanFingerprint;
  if (typeof scanFingerprint !== "string" || !scanFingerprint.trim()) {
    throw new Error(`FlowWeave protocol v7 snapshot has an invalid scanFingerprint. Rescan the project before starting Agent artifact review: ${projectPath}`);
  }
  return scanFingerprint;
}

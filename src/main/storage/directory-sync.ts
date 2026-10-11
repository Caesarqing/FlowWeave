import { open } from "node:fs/promises";

export async function syncDirectory(path: string): Promise<void> {
  // shortcut: Node cannot fsync directories on Windows; revisit if a supported directory-flush API is added.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

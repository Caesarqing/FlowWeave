import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { syncDirectory } from "../../src/main/storage/directory-sync";

it("skips directory syncing on Windows", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(globalThis.process, "platform");
  if (!originalPlatform) throw new Error("The process platform descriptor is unavailable.");
  Object.defineProperty(globalThis.process, "platform", { ...originalPlatform, value: "win32" });
  try {
    await expect(syncDirectory(join(tmpdir(), `flowweave-missing-${randomUUID()}`))).resolves.toBeUndefined();
  } finally {
    Object.defineProperty(globalThis.process, "platform", originalPlatform);
  }
});

it("syncs an existing directory on platforms that support it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowweave-directory-sync-"));
  await expect(syncDirectory(directory)).resolves.toBeUndefined();
});

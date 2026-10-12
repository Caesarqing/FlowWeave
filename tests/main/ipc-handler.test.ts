import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { normalizeIpcError } from "../../src/main/ipc/ipc-handler";
import { ArtifactGenerationMismatchError } from "../../src/main/services/generation-errors";

it("identifies a stale generation as a reload issue instead of a file permission failure", () => {
  const error = new ArtifactGenerationMismatchError("/project", "canvas/user-state.json",
    { requestId: "new", inputFingerprint: "same" }, { requestId: "old", inputFingerprint: "same" });
  const result = normalizeIpcError("project:save-canvas", error);

  expect(result.code).toBe("artifact-generation-mismatch");
  expect(result.category).toBe("validation");
  expect(result.suggestedActions[0]).toContain("Reopen the project");
});

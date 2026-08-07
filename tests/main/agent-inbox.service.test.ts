import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveAndClearAgentInbox,
  getAgentInboxArchiveInvalidResponsePath,
  getAgentInboxArchiveRequestPath,
  getAgentInboxRequestPath,
  getAgentInboxResponsePath,
  parseAgentInboxResponse,
  readAgentInboxResponseForRun,
  writeAgentInboxRequest
} from "../../src/main/services/agent-inbox.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";

describe("agent-inbox.service", () => {
  it("writes the active request to the current inbox", async () => {
    const projectPath = await createProject();

    await writeAgentInboxRequest({
      id: "run-1",
      projectId: "project-1",
      projectPath,
      prompt: "Inspect the project.",
      executionMode: "plan",
      purpose: "implementation-plan"
    }, "codex-local");

    await expect(readFile(getAgentInboxRequestPath(projectPath), "utf8")).resolves.toContain('"protocolVersion": 2');
    await expect(readFile(getAgentInboxRequestPath(projectPath), "utf8")).resolves.toContain('"responsePath"');
  });

  it("rejects a second active request before the first response is imported", async () => {
    const projectPath = await createProject();

    await writeAgentInboxRequest({
      id: "run-1",
      projectId: "project-1",
      projectPath,
      prompt: "Inspect the project.",
      executionMode: "plan",
      purpose: "implementation-plan"
    }, "codex-local");

    await expect(writeAgentInboxRequest({
      id: "run-2",
      projectId: "project-1",
      projectPath,
      prompt: "Inspect again.",
      executionMode: "plan",
      purpose: "implementation-plan"
    }, "codex-local")).rejects.toThrow("Agent inbox already has an active request: run-1");
  });

  it("parses string and object content responses", () => {
    const stringResponse = parseAgentInboxResponse(JSON.stringify({
      protocolVersion: 2,
      runId: "run-1",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: "# Plan",
      completedAt: "2026-08-07T00:00:00.000Z"
    }), "/tmp/response.json");
    const objectResponse = parseAgentInboxResponse(JSON.stringify({
      protocolVersion: 2,
      runId: "run-1",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: { version: 1 },
      completedAt: "2026-08-07T00:00:00.000Z"
    }), "/tmp/response.json");

    expect(stringResponse.content).toBe("# Plan");
    expect(objectResponse.content).toContain('"version": 1');
  });

  it("validates response identity for the expected run", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "agent-inbox", "current"), { recursive: true });
    await writeFile(getAgentInboxResponsePath(projectPath), JSON.stringify({
      protocolVersion: 2,
      runId: "run-other",
      projectId: "project-1",
      status: "completed",
      summary: "done",
      content: "# Plan",
      completedAt: "2026-08-07T00:00:00.000Z"
    }), "utf8");

    await expect(readAgentInboxResponseForRun(projectPath, "run-1", {
      id: "run-1",
      projectId: "project-1"
    })).rejects.toThrow("runId mismatch: expected run-1, received run-other");
  });

  it("archives malformed response JSON as raw text and clears the current inbox", async () => {
    const projectPath = await createProject();
    await writeAgentInboxRequest({
      id: "run-1",
      projectId: "project-1",
      projectPath,
      prompt: "Inspect the project.",
      executionMode: "plan",
      purpose: "implementation-plan"
    }, "codex-local");
    await writeFile(getAgentInboxResponsePath(projectPath), "{not valid json", "utf8");

    await archiveAndClearAgentInbox(projectPath, "run-1");

    await expect(readFile(getAgentInboxArchiveRequestPath(projectPath, "run-1"), "utf8")).resolves.toContain('"runId": "run-1"');
    await expect(readFile(getAgentInboxArchiveInvalidResponsePath(projectPath, "run-1"), "utf8")).resolves.toBe("{not valid json");
    await expect(readFile(getAgentInboxRequestPath(projectPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-inbox-"));
  await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
  return projectPath;
}

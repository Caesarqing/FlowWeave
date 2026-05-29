import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunEvent, ToolRunResult } from "../agents/agent-adapter";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export type RunPaths = {
  runDir: string;
  promptPath: string;
  planPath: string;
  logPath: string;
  resultPath: string;
};

export async function prepareRunPaths(projectPath: string, runId: string): Promise<RunPaths> {
  const runDir = join(projectPath, FLOWWEAVE_DIR, "runs", runId);
  await mkdir(runDir, { recursive: true });

  return {
    runDir,
    promptPath: join(runDir, "prompt.md"),
    planPath: join(runDir, "plan.md"),
    logPath: join(runDir, "agent.log"),
    resultPath: join(runDir, "result.json")
  };
}

export function serializeAgentEvents(events: ToolRunEvent[]) {
  return events
    .map((event) => {
      if (event.type === "status") {
        return `[${event.timestamp}] status ${event.status}`;
      }

      if (event.type === "error") {
        return `[${event.timestamp}] error ${event.message}`;
      }

      return `[${event.timestamp}] ${event.type}\n${event.content.trimEnd()}`;
    })
    .join("\n\n");
}

export async function writeRunResult(resultPath: string, result: ToolRunResult, extra: Record<string, unknown>) {
  await writeFile(resultPath, `${JSON.stringify({ ...result, ...extra }, null, 2)}\n`, "utf8");
}

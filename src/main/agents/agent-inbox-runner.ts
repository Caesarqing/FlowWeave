import type { RuntimeAgentId, ToolRunEvent, ToolRunRequest, ToolRunResult } from "../../types";
import {
  buildAgentInboxInstruction,
  readAgentInboxResponseForRun,
  writeAgentInboxRequest
} from "../services/agent-inbox.service";
import { runSpawnedAgent } from "./spawn-agent-process";
import { nowIso } from "./time";

export type RunCliAgentInboxOptions = {
  toolId: RuntimeAgentId;
  commandPath: string;
  args: string[];
  request: ToolRunRequest;
  lastMessagePath?: string;
};

export async function runCliAgentInbox(
  options: RunCliAgentInboxOptions,
  onEvent?: (event: ToolRunEvent) => void
): Promise<ToolRunResult> {
  await writeAgentInboxRequest(options.request, options.toolId);
  const processResult = await runSpawnedAgent({
    toolId: options.toolId,
    commandPath: options.commandPath,
    args: options.args,
    request: options.request,
    stdin: buildAgentInboxInstruction(options.request.projectPath, options.request.id),
    lastMessagePath: options.lastMessagePath
  }, onEvent);
  if (processResult.terminationReason === "timed-out") {
    return { ...processResult, projectId: options.request.projectId };
  }
  const response = await readAgentInboxResponseForRun(options.request.projectPath, options.request.id, {
    ...processResult,
    projectId: options.request.projectId
  });
  if (response) {
    return {
      ...processResult,
      projectId: options.request.projectId,
      status: response.status,
      completedAt: response.completedAt,
      exitCode: response.status === "completed" ? 0 : 1,
      summary: response.error?.message ?? response.summary,
      outputText: response.content,
      failure: response.status === "failed"
        ? {
            code: "process",
            message: response.error?.message ?? response.summary,
            transient: false,
            source: "error",
            exitCode: 1,
            suggestedActions: ["Inspect the Agent Inbox response error and retry after correcting the request or agent configuration."]
          }
        : undefined
    };
  }

  const timestamp = nowIso();
  const events = [
    ...processResult.events,
    {
      type: "error" as const,
      message: `Agent did not write Agent Inbox response for run ${options.request.id}.`,
      timestamp
    },
    { type: "status" as const, status: "failed" as const, timestamp }
  ];
  return {
    ...processResult,
    projectId: options.request.projectId,
    status: "failed",
    completedAt: timestamp,
    exitCode: processResult.exitCode ?? 1,
    summary: `Agent did not write Agent Inbox response for run ${options.request.id}.`,
    events,
    terminationReason: processResult.terminationReason === "completed" ? "failed" : processResult.terminationReason
  };
}

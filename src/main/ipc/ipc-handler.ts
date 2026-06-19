import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { FlowWeaveErrorData } from "../../types";
import { FlowWeaveError } from "../services/flowweave-error.service";

export const FLOWWEAVE_ERROR_PREFIX = "FLOWWEAVE_ERROR:";

export function handleIpc(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } catch (error) {
      const data = normalizeIpcError(channel, error);
      throw new Error(`${FLOWWEAVE_ERROR_PREFIX}${JSON.stringify(data)}`);
    }
  });
}

export function normalizeIpcError(channel: string, error: unknown): FlowWeaveErrorData {
  if (error instanceof FlowWeaveError) {
    return {
      code: error.code,
      category: error.category,
      message: error.message,
      context: { channel, ...error.context },
      suggestedActions: error.suggestedActions,
      technicalDetails: error.category === "canceled" ? undefined : error.technicalDetails ?? error.stack
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const category = categorizeError(message);
  return {
    code: `${category}-operation-failed`,
    category,
    message,
    context: { channel },
    suggestedActions: suggestedActions(category, message),
    technicalDetails: error instanceof Error ? error.stack : undefined
  };
}

function categorizeError(message: string): FlowWeaveErrorData["category"] {
  if (/cancel/i.test(message)) return "canceled";
  if (/unauthori[sz]ed|escapes|traversal|sensitive|permission|checkpoint/i.test(message)) return "security";
  if (/agent|codex|claude|gemini|cursor|cli|timeout|output limit/i.test(message)) return "agent";
  if (/ENOENT|EACCES|file|directory|path|read|write|artifact/i.test(message)) return "filesystem";
  if (/invalid|required|expected|must|cannot contain|exceeds/i.test(message)) return "validation";
  return "internal";
}

function suggestedActions(category: FlowWeaveErrorData["category"], message: string): string[] {
  if (/already running|read execution|queue is full|concurrent/i.test(message)) {
    return [
      "Wait for the current Agent run to finish, then retry.",
      "Open the Agent run history to check whether another plan is still running or pending."
    ];
  }
  if (category === "validation") return ["Review the submitted values and retry."];
  if (category === "security") return ["Verify the project path, Git state, and requested permissions before retrying."];
  if (category === "filesystem") return ["Verify the file still exists and that FlowWeave has permission to access it."];
  if (category === "agent") return ["Check the Agent installation and configuration, then retry the operation."];
  if (category === "canceled") return ["Retry the operation when ready."];
  return ["Export diagnostics and review the technical details before retrying."];
}

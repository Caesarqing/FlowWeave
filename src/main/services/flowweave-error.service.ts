import type { FlowWeaveErrorCategory, FlowWeaveErrorData, ToolRunTerminationReason } from "../../types";

export class FlowWeaveError extends Error {
  readonly code: string;
  readonly category: FlowWeaveErrorCategory;
  readonly context: FlowWeaveErrorData["context"];
  readonly suggestedActions: string[];
  readonly technicalDetails?: string;

  constructor(data: FlowWeaveErrorData) {
    super(data.message);
    this.name = "FlowWeaveError";
    this.code = data.code;
    this.category = data.category;
    this.context = data.context;
    this.suggestedActions = data.suggestedActions;
    this.technicalDetails = data.technicalDetails;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (!signal?.aborted) return;
  throw new FlowWeaveError({
    code: "operation-canceled",
    category: "canceled",
    message: `${operation} was canceled.`,
    context: { operation, reason: String(signal.reason ?? "canceled") },
    suggestedActions: ["Retry the operation when ready."]
  });
}

export function throwIfRunCanceled(
  result: { terminationReason?: ToolRunTerminationReason },
  operation: string,
  signal: AbortSignal | undefined
): void {
  if (
    result.terminationReason !== "canceled" ||
    !signal?.aborted ||
    signal.reason !== "user-canceled"
  ) return;
  throw new FlowWeaveError({
    code: "operation-canceled",
    category: "canceled",
    message: `${operation} was canceled.`,
    context: { operation, reason: "agent-run-canceled" },
    suggestedActions: ["Retry the operation when ready."]
  });
}

export function shouldBroadcastFlowWeaveError(error: FlowWeaveErrorData): boolean {
  return error.category !== "canceled";
}

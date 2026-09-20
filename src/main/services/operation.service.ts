import { randomUUID } from "node:crypto";
import type { AnalysisOperation, AnalysisProgressUpdate } from "../../types";

type ActiveOperation = { state: AnalysisOperation };

const operations = new Map<string, ActiveOperation>();

export function startOperation(
  kind: AnalysisOperation["kind"],
  message: string,
  projectId: string
): { operation: AnalysisOperation } {
  const timestamp = new Date().toISOString();
  const operation: AnalysisOperation = {
    operationId: `operation-${randomUUID()}`,
    projectId,
    kind,
    stage: "discovery",
    completed: 0,
    total: 0,
    failed: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    message
  };
  operations.set(operation.operationId, { state: operation });
  return { operation };
}

export function updateOperation(
  operationId: string,
  update: AnalysisProgressUpdate
): AnalysisOperation {
  const active = requireOperation(operationId);
  const state = { ...active.state, ...update, updatedAt: new Date().toISOString() };
  operations.set(operationId, { ...active, state });
  return state;
}

export function finishOperation(operationId: string): void {
  operations.delete(operationId);
}

export function resetOperationsForTests(): void {
  operations.clear();
}

function requireOperation(operationId: string): ActiveOperation {
  if (!/^operation-[a-f0-9-]{36}$/.test(operationId)) {
    throw new Error(`Invalid FlowWeave operation id: ${operationId}`);
  }
  const operation = operations.get(operationId);
  if (!operation) throw new Error(`FlowWeave operation not found: ${operationId}`);
  return operation;
}

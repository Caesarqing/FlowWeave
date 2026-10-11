import type { CanvasSaveReceipt, CodeflowCanvas } from "../types";

export function createCanvasSaveCoordinator(
  persist: (projectId: string, canvas: CodeflowCanvas) => Promise<CanvasSaveReceipt>
) {
  const pending = new Map<string, Promise<void>>();
  const latest = new Map<string, Promise<CanvasSaveReceipt>>();
  const revisions = new Map<string, number>();

  function save(projectId: string, canvas: CodeflowCanvas): Promise<CanvasSaveReceipt> {
    const generationId = canvas.generation?.requestId;
    if (!generationId || canvas.userRevision === undefined) {
      return Promise.reject(new Error(`Canvas save requires a generation and revision: project ${projectId}`));
    }
    const key = `${projectId}:${generationId}`;
    const previous = pending.get(key) ?? Promise.resolve();
    const current = previous.then(async () => {
      const revision = revisions.get(key) ?? canvas.userRevision;
      const receipt = await persist(projectId, { ...canvas, userRevision: revision });
      if (receipt.generationId !== generationId) {
        throw new Error(`Canvas save returned a different generation: project ${projectId}, expected ${generationId}, actual ${receipt.generationId}`);
      }
      revisions.set(key, receipt.userRevision);
      return receipt;
    });
    const settled = current.then(() => undefined, () => undefined);
    pending.set(key, settled);
    latest.set(key, current);
    void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return current;
  }

  function flush(projectId: string, generationId: string): Promise<void> {
    const key = `${projectId}:${generationId}`;
    return (latest.get(key) ?? Promise.resolve()).then(() => undefined);
  }

  return { save, flush };
}

export const canvasSaveCoordinator = createCanvasSaveCoordinator((projectId, canvas) => {
  if (!window.flowweave) throw new Error(`FlowWeave desktop API is unavailable while saving project ${projectId}`);
  return window.flowweave.saveCanvas(projectId, canvas);
});

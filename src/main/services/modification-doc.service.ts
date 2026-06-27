import { join } from "node:path";
import type { CodeflowCanvas, SequenceDiagramBundle } from "../../types";
import {
  buildModificationDeltaContextJson,
  buildModificationDeltaGuidanceMarkdown,
  createModificationGuidanceContext
} from "../../utils/export-artifacts";
import { writeTextAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { modificationProjectLabel, readModificationDelta } from "./modification-delta.service";

export const MODIFICATION_GUIDANCE_DOC_ID = "modification-guidance";
export const MODIFICATION_CONTEXT_DOC_ID = "modification-context";

export type ModificationDocPaths = {
  guidancePath: string;
  contextPath: string;
};

export async function writeModificationDocs(
  projectPath: string,
  input: { canvas?: CodeflowCanvas; sequence?: SequenceDiagramBundle; sequenceInstruction?: string }
): Promise<ModificationDocPaths> {
  const result = await readModificationDelta(
    projectPath,
    input.sequenceInstruction ?? "",
    input.canvas
  );
  const context = createModificationGuidanceContext(
    input.sequence?.projectName ?? input.canvas?.title ?? modificationProjectLabel(projectPath),
    projectPath,
    result
  );
  const guidancePath = join(projectPath, FLOWWEAVE_DIR, "docs", `${MODIFICATION_GUIDANCE_DOC_ID}.md`);
  const contextPath = join(projectPath, FLOWWEAVE_DIR, "docs", `${MODIFICATION_CONTEXT_DOC_ID}.json`);
  await Promise.all([
    writeTextAtomic(guidancePath, buildModificationDeltaGuidanceMarkdown(context)),
    writeTextAtomic(contextPath, buildModificationDeltaContextJson(context))
  ]);
  return { guidancePath, contextPath };
}

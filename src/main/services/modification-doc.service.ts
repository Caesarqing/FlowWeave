import { basename, join } from "node:path";
import type { CodeflowCanvas, SequenceDiagramBundle } from "../../types";
import {
  buildModificationContext,
  buildModificationContextJson,
  buildModificationGuidanceMarkdown,
  type FlowWeaveModificationContext
} from "../../utils/export-artifacts";
import { readJsonArtifact, writeTextAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export const MODIFICATION_GUIDANCE_DOC_ID = "modification-guidance";
export const MODIFICATION_CONTEXT_DOC_ID = "modification-context";

export type ModificationDocPaths = {
  guidancePath: string;
  contextPath: string;
};

export async function writeModificationGuidanceDoc(projectPath: string, canvas: CodeflowCanvas): Promise<string> {
  const paths = await writeModificationDocs(projectPath, { canvas });
  return paths.guidancePath;
}

export async function writeModificationDocs(
  projectPath: string,
  input: { canvas?: CodeflowCanvas; sequence?: SequenceDiagramBundle; sequenceInstruction?: string }
): Promise<ModificationDocPaths> {
  const [canvas, sequence] = await Promise.all([
    input.canvas ? Promise.resolve(input.canvas) : readCurrentCanvas(projectPath),
    input.sequence ? Promise.resolve(input.sequence) : readCurrentSequence(projectPath)
  ]);
  const context = buildContext(projectPath, canvas, sequence, input.sequenceInstruction);
  const guidancePath = join(projectPath, FLOWWEAVE_DIR, "docs", `${MODIFICATION_GUIDANCE_DOC_ID}.md`);
  const contextPath = join(projectPath, FLOWWEAVE_DIR, "docs", `${MODIFICATION_CONTEXT_DOC_ID}.json`);
  await Promise.all([
    writeTextAtomic(guidancePath, buildModificationGuidanceMarkdown(context)),
    writeTextAtomic(contextPath, buildModificationContextJson(context))
  ]);
  return { guidancePath, contextPath };
}

export { buildModificationGuidanceMarkdown };

function buildContext(
  projectPath: string,
  canvas: CodeflowCanvas | undefined,
  sequence: SequenceDiagramBundle | undefined,
  sequenceInstruction: string | undefined
): FlowWeaveModificationContext {
  return buildModificationContext({
    projectLabel: sequence?.projectName ?? canvas?.title ?? basename(projectPath),
    projectPath,
    scanFingerprint: canvas?.scanFingerprint,
    nodes: canvas?.nodes ?? [],
    edges: canvas?.edges ?? [],
    sequenceBundle: sequence,
    sequenceInstruction,
    generatedAt: new Date().toISOString()
  });
}

async function readCurrentCanvas(projectPath: string): Promise<CodeflowCanvas | undefined> {
  const value = await readOptionalJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json"));
  if (!value || typeof value !== "object") return undefined;
  const canvas = value as Partial<CodeflowCanvas>;
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) return undefined;
  return canvas as CodeflowCanvas;
}

async function readCurrentSequence(projectPath: string): Promise<SequenceDiagramBundle | undefined> {
  const value = await readOptionalJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "sequence-diagrams.json"));
  if (!value || typeof value !== "object") return undefined;
  const bundle = value as Partial<SequenceDiagramBundle>;
  if (!bundle.architectural || !Array.isArray(bundle.architectural.messages)) return undefined;
  return bundle as SequenceDiagramBundle;
}

async function readOptionalJsonArtifact(path: string): Promise<unknown | undefined> {
  try {
    return await readJsonArtifact(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FlowWeave artifact is unreadable and was preserved:")) {
      return undefined;
    }
    throw error;
  }
}

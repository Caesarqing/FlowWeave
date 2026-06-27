import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCurrentModuleGuidancePrompt,
  buildModificationDeltaAgentPrompt,
  createModificationGuidanceContext
} from "../../src/utils/export-artifacts";
import type { GraphNode, ModificationDeltaResult } from "../../src/types";

const modulePanelSource = readFileSync(
  new URL("../../src/components/ModulePanel.tsx", import.meta.url),
  "utf8"
);
const structureWorkspaceSource = readFileSync(
  new URL("../../src/components/StructureWorkspace.tsx", import.meta.url),
  "utf8"
);
const topBarSource = readFileSync(
  new URL("../../src/components/TopBar.tsx", import.meta.url),
  "utf8"
);
const appSource = readFileSync(
  new URL("../../src/App.tsx", import.meta.url),
  "utf8"
);
const sequenceStateSource = readFileSync(
  new URL("../../src/hooks/useSequenceDiagramState.ts", import.meta.url),
  "utf8"
);

describe("agent guidance interactions", () => {
  it("builds a current-module prompt without other Canvas modules or relations", () => {
    const prompt = buildCurrentModuleGuidancePrompt(moduleFixture(), "Only update Store tests.");

    expect(prompt).toContain("Module ID: store");
    expect(prompt).toContain("Module title: Store");
    expect(prompt).toContain("Only update Store tests.");
    expect(prompt).not.toContain("Payments");
    expect(prompt).not.toContain("calls");
  });

  it("uses the shared single-input guidance composer in Canvas and Sequence panels", () => {
    expect(modulePanelSource).toContain("<AgentGuidanceComposer");
    expect(structureWorkspaceSource).toContain("<AgentGuidanceComposer");
    expect(modulePanelSource).not.toContain("dialogText");
    expect(modulePanelSource).not.toContain("dialog-box");
  });

  it("shows the full modification send action on the Canvas page", () => {
    expect(topBarSource).toContain('activePage === "canvas"');
    expect(topBarSource).toContain('t("top.sendAllGuidance")');
    expect(topBarSource).toContain("sendDisabled");
    expect(appSource).toContain("sendDisabled={");
  });

  it("builds a compact prompt from pending modifications and artifact references", () => {
    const result: ModificationDeltaResult = {
      baseline: {
        version: 1,
        acknowledgedAt: "2026-06-25T00:00:00.000Z",
        canvas: { modules: [], relations: [] }
      },
      snapshot: {
        canvas: { modules: [], relations: [] },
        sequenceInstruction: "Split payment into authorize and capture."
      },
      delta: {
        modules: {
          added: [],
          updated: [{
            id: "store",
            title: "Store",
            changes: { guidanceDraft: "Only update Store tests." }
          }],
          deleted: []
        },
        relations: { added: [], updated: [], deleted: [] },
        sequenceInstruction: "Split payment into authorize and capture."
      },
      hasChanges: true
    };
    const prompt = buildModificationDeltaAgentPrompt(
      createModificationGuidanceContext("Fixture", "/tmp/fixture", result),
      "plan"
    );

    expect(prompt).toContain("Only update Store tests.");
    expect(prompt).toContain("Split payment into authorize and capture.");
    expect(prompt).toContain(".flowweave/sequence-diagrams.json");
    expect(prompt).not.toContain("Call API");
  });

  it("saves Canvas and Sequence guidance before sending the full prompt", () => {
    const controllerSource = readFileSync(
      new URL("../../src/hooks/useAppController.ts", import.meta.url),
      "utf8"
    );
    const functionStart = controllerSource.indexOf("async function sendCompleteGuidanceToAgent()");
    const saveCanvasCall = controllerSource.indexOf("await saveCanvasArtifacts()", functionStart);
    const saveSequenceCall = controllerSource.indexOf("await api.saveModificationDocs", functionStart);
    const promptCall = controllerSource.indexOf("buildModificationDeltaAgentPrompt", functionStart);
    const acknowledgeCall = controllerSource.indexOf("acknowledgeModificationChanges", promptCall);

    expect(functionStart).toBeGreaterThan(-1);
    expect(saveCanvasCall).toBeGreaterThan(functionStart);
    expect(saveSequenceCall).toBeGreaterThan(saveCanvasCall);
    expect(promptCall).toBeGreaterThan(saveSequenceCall);
    expect(acknowledgeCall).toBeGreaterThan(promptCall);
  });

  it("acknowledges module guidance and Sequence instructions only after successful sends", () => {
    const controllerSource = readFileSync(
      new URL("../../src/hooks/useAppController.ts", import.meta.url),
      "utf8"
    );

    expect(controllerSource).toContain('{ kind: "module-guidance", moduleId: selectedNode.id }');
    expect(sequenceStateSource).toContain('{ kind: "sequence" }');
    expect(controllerSource).toContain('result?.status === "completed"');
  });

  it("saves a sequence instruction before asking the agent to revise the diagram", () => {
    const saveCall = sequenceStateSource.indexOf("await persistInstruction()");
    const reviseCall = sequenceStateSource.indexOf("await window.flowweave.reviseSequenceDiagram");

    expect(saveCall).toBeGreaterThan(-1);
    expect(reviseCall).toBeGreaterThan(saveCall);
  });
});

function moduleFixture(): GraphNode {
  return {
    id: "store",
    title: "Store",
    subtitle: "State",
    kind: "module",
    nodeType: "service",
    risk: "medium",
    description: "Application state.",
    files: ["src/stores/store.ts"],
    guidanceDraft: "Only update Store tests.",
    status: "needs-review",
    x: 0,
    y: 0
  };
}

import type { AgentAnalysisResult, CodeflowProject, RuntimeAgentId } from "../../types";
import {
  analyzeArchitecture,
  architectureMapToModuleMap,
  architectureMapToProjectMap,
  buildArchitecturePrompt
} from "./architecture-analysis.service";
import { buildProjectStructureFacts } from "./structure-extractor.service";

export async function analyzeProject(project: CodeflowProject, toolId: RuntimeAgentId): Promise<AgentAnalysisResult> {
  const architecture = await analyzeArchitecture(project, toolId);
  if (architecture.outcome === "failed") {
    throw new Error(
      `Architecture analysis failed for ${architecture.error.agentId} run ${architecture.error.runId ?? "unknown"}: ${architecture.error.message}`
    );
  }
  return {
    projectMap: architectureMapToProjectMap(architecture.architectureMap),
    moduleMap: architectureMapToModuleMap(architecture.architectureMap),
    source: architecture.architectureMap.source,
    graph: architecture.graph
  };
}

export async function buildAnalysisPrompt(project: CodeflowProject) {
  const facts = await buildProjectStructureFacts(project);
  return buildArchitecturePrompt(facts);
}

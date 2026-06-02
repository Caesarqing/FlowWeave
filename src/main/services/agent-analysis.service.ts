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
  return {
    projectMap: architectureMapToProjectMap(architecture.architectureMap),
    moduleMap: architectureMapToModuleMap(architecture.architectureMap),
    source: architecture.source,
    agentOutput: architecture.agentOutput,
    graph: architecture.graph
  };
}

export async function buildAnalysisPrompt(project: CodeflowProject) {
  const facts = await buildProjectStructureFacts(project);
  return buildArchitecturePrompt(facts);
}

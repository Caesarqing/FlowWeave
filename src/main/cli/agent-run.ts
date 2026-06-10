import { resolve } from "node:path";
import type { ExecutionMode, ToolId, ToolRunPurpose } from "../../types";
import { detectTool, startToolPlan } from "../services/agent-run.service";
import { registerProject } from "../services/project-registry.service";

async function main() {
  const projectPath = resolve(readOption("--project") ?? process.cwd());
  const toolId = (readOption("--tool") ?? readOption("--agent") ?? "mock") as ToolId;
  const prompt = readOption("--prompt");
  const guidancePath = readOption("--guidance");
  const executionMode: ExecutionMode = process.argv.includes("--execute") ? "execute" : "plan";
  const purpose: ToolRunPurpose = process.argv.includes("--artifact-analysis")
    ? "artifact-analysis"
    : "implementation-plan";
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    const status = await detectTool(toolId);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  if (!prompt?.trim()) {
    throw new Error("--prompt is required when starting an agent run.");
  }
  const projectId = await registerProject(projectPath);
  const result = await startToolPlan({
    projectId,
    toolId,
    prompt,
    guidancePath: guidancePath ? resolve(guidancePath) : undefined,
    executionMode,
    purpose
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        id: result.id,
        toolId: result.toolId,
        status: result.status,
        executionMode: result.executionMode,
        promptPath: result.promptPath,
        planPath: result.planPath,
        logPath: result.logPath,
        resultPath: result.resultPath
      },
      null,
      2
    )}\n`
  );
}

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FlowWeave tool run failed: ${message}\n`);
  process.exitCode = 1;
});

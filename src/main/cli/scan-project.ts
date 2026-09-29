import { resolve } from "node:path";
import { generateProject } from "../services/project-generation.service";

async function main() {
  const projectPath = resolve(process.argv[2] ?? process.cwd());
  const result = await generateProject(projectPath, {});
  if (result.status === "superseded") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const { project, architectureMap, graph, written } = result;

  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        generation: result.generation,
        project: {
          name: project.projectName,
          rootPath: project.rootPath,
          git: project.git,
          summary: project.summary
        },
        graph: {
          nodes: graph.nodes.length,
          edges: graph.edges.length
        },
        quality: architectureMap.quality, groups: architectureMap.groups?.length, resources: architectureMap.resources?.length,
        written
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FlowWeave scan failed: ${message}\n`);
  process.exitCode = 1;
});

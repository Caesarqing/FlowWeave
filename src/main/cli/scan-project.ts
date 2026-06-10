import { resolve } from "node:path";
import { scanProject } from "../services/project-scanner.service";
import { inferGraphFromProject } from "../services/task-generator.service";
import { writeFlowWeaveProject } from "../storage/flowweave-store";

async function main() {
  const projectPath = resolve(process.argv[2] ?? process.cwd());
  const project = await scanProject(projectPath);
  const graph = await inferGraphFromProject(project);
  const written = await writeFlowWeaveProject(
    projectPath,
    project,
    graph.nodes,
    graph.edges,
    project.scanFingerprint ?? ""
  );

  process.stdout.write(
    `${JSON.stringify(
      {
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphEdge, GraphNode } from "../../types";
import { writeAgentConnectors } from "../services/agent-connector.service";
import { createCanvasArtifact, createTaskArtifact, createTaskMarkdown } from "../services/task-generator.service";
import { FLOWWEAVE_DIR } from "./flowweave-paths";
import type { CodeflowProject, CodeflowWriteResult, ProjectFileNode } from "./schemas";

export async function writeFlowWeaveProject(
  rootPath: string,
  project: CodeflowProject,
  modules: GraphNode[],
  edges?: GraphEdge[]
): Promise<CodeflowWriteResult> {
  const flowweaveRoot = join(rootPath, FLOWWEAVE_DIR);
  const canvasDir = join(flowweaveRoot, "canvas");
  const tasksDir = join(flowweaveRoot, "tasks");
  const contextDir = join(flowweaveRoot, "context");

  await Promise.all([
    mkdir(canvasDir, { recursive: true }),
    mkdir(tasksDir, { recursive: true }),
    mkdir(contextDir, { recursive: true })
  ]);

  const canvas = createCanvasArtifact(rootPath, modules, edges);
  const task = createTaskArtifact(modules, edges);
  const taskMarkdown = createTaskMarkdown(task);

  const projectJsonPath = join(flowweaveRoot, "project.json");
  const canvasJsonPath = join(canvasDir, "main.canvas.json");
  const taskMarkdownPath = join(tasksDir, `${task.id}.task.md`);
  const taskJsonPath = join(tasksDir, `${task.id}.task.json`);
  const contextFileTreePath = join(contextDir, "file-tree.md");

  await Promise.all([
    writeJson(projectJsonPath, project),
    writeJson(canvasJsonPath, canvas),
    writeFile(taskMarkdownPath, taskMarkdown, "utf8"),
    writeJson(taskJsonPath, task),
    writeFile(contextFileTreePath, createFileTreeMarkdown(project.files), "utf8")
  ]);

  await writeAgentConnectors({
    project,
    modules,
    edges: canvas.edges,
    canvasPath: canvasJsonPath,
    taskMarkdownPath,
    taskJsonPath,
    contextFileTreePath
  });

  return {
    projectJsonPath,
    canvasJsonPath,
    taskMarkdownPath,
    taskJsonPath,
    contextFileTreePath
  };
}

function writeJson(filePath: string, data: unknown) {
  return writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createFileTreeMarkdown(nodes: ProjectFileNode[]) {
  const lines = ["# Project File Tree", ""];

  function visit(node: ProjectFileNode) {
    const indent = "  ".repeat(node.depth);
    const marker = node.type === "folder" ? "/" : "";
    lines.push(`${indent}- ${node.name}${marker}`);
    node.children?.forEach(visit);
  }

  nodes.forEach(visit);
  lines.push("");
  return lines.join("\n");
}

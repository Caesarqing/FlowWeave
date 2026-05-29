import type { GraphEdge, GraphNode } from "../types";

export function buildGuidanceMarkdown(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[]) {
  return `# FlowWeave Guidance

Project: ${projectLabel}
Target agents: Codex Local / Claude Code / Cursor

## Graph Rule

Use the module nodes and connection relations as the modification boundary. Prefer files listed on the selected node; follow connected nodes only when the relation requires it.

## Module Relations

${edges.map((edge) => `- ${edge.source} -> ${edge.target} (${edge.relation})${edge.guidanceNote ? `: ${edge.guidanceNote}` : ""}`).join("\n")}

## Modules

${nodes
  .map(
    (node) => `### ${node.title}

Type: ${node.nodeType}
Risk: ${node.risk}

${node.description}

Files:
${node.files.map((file) => `- ${file}`).join("\n")}

Guidance:
${node.guidanceDraft}
`
  )
  .join("\n")}
`;
}

export function buildTaskJson(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[]) {
  return JSON.stringify(
    {
      project: projectLabel,
      source: "FlowWeave",
      targetTools: ["codex-local", "claude-code", "cursor"],
      outputFiles: ["guidance.md", "task.json", "plan.md"],
      modules: nodes.map((node) => ({
        id: node.id,
        title: node.title,
        kind: node.kind,
        nodeType: node.nodeType,
        risk: node.risk,
        description: node.description,
        files: node.files,
        guidance: node.guidanceDraft,
        position: { x: node.x, y: node.y }
      })),
      relations: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        guidanceNote: edge.guidanceNote
      }))
    },
    null,
    2
  );
}

export function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

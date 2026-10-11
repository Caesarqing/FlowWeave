const fs = require('node:fs');
const Graph = require('graphology');
const louvain = require('graphology-communities-louvain');
const report = JSON.parse(fs.readFileSync('depcruise-ts.json', 'utf8'));
const graph = new Graph.UndirectedGraph();
for (const module of report.modules) graph.addNode(module.source);
for (const module of report.modules) for (const dependency of module.dependencies) {
  if (dependency.resolved && graph.hasNode(dependency.resolved)) graph.addEdge(module.source, dependency.resolved);
}
console.log(JSON.stringify({ nodes: graph.order, edges: graph.size, communities: louvain(graph) }, null, 2));

const Graph = require('graphology');
const louvain = require('graphology-communities-louvain');
const graph = new Graph.UndirectedGraph();
for (const node of ['src/app.ts', 'src/core/index.ts', 'src/core/service.ts']) graph.addNode(node);
graph.addEdge('src/app.ts', 'src/core/index.ts');
graph.addEdge('src/core/index.ts', 'src/core/service.ts');
const communities = louvain(graph);
console.log(JSON.stringify({ nodes: graph.order, edges: graph.size, communities }, null, 2));

# T7 component-level React Profiler DEV sample

Three isolated Electron smoke runs used the synthetic `viewport-only` fixture and a DEV renderer. Each run created its own temporary project and `userData`; no real project or holdout data was used. React was 19.2.6, Electron 42.8.1, and Chromium 148.0.7778.280. The renderer recorded `CanvasWorkspace`, module nodes, group nodes, smoothstep edges, `ModulePanel`, and `ConnectionPanel` separately. The two panel samples were captured only during their matching synthetic selection action.

## Reproduction

Build the main and preload entries so the smoke driver includes component-profile actions:

```sh
npm run typecheck
npx electron-vite build
```

Start a Vite renderer server without launching Electron:

```sh
VITE_FLOWWEAVE_REACT_PROFILE=1 node --input-type=module -e 'import { createServer } from "vite"; import react from "@vitejs/plugin-react"; const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], define: { "import.meta.env.VITE_BUILD_TIME": JSON.stringify("t7-profiler-dev") }, publicDir: "logo", server: { host: "127.0.0.1", port: 5173, strictPort: true } }); await server.listen(); server.printUrls(); process.on("SIGINT", () => { void server.close().then(() => process.exit(0)); });'
```

With that process running, execute the following three times, changing the evidence filename each time:

```sh
FLOWWEAVE_GRAPH_SMOKE_FIXTURE=viewport-only \
FLOWWEAVE_GRAPH_SMOKE_LAYOUT_STATE=1 \
FLOWWEAVE_GRAPH_SMOKE_COMPONENT_PROFILE=1 \
FLOWWEAVE_GRAPH_SMOKE_RENDERER_URL=http://127.0.0.1:5173/ \
FLOWWEAVE_GRAPH_SMOKE_EVIDENCE_PATH=docs/evidence/static-graph-generalization/T7-react-profiler-component-dev-clean-panels-2026-10-06.json \
npm run smoke:graph
```

The runner launches Electron with its graph-smoke argument and a fresh temporary project and `userData`. Each of the three completed `smoke:graph` invocations exited 0 after the persisted layout-state and component-presence/action assertions passed. Raw reports and SHA-256:

- [`clean-panels`](T7-react-profiler-component-dev-clean-panels-2026-10-06.json): `d55892efa7834ddd0a44ee76ccb461eff625928911d63b95259979b610d11025`
- [`run-2`](T7-react-profiler-component-dev-run-2-2026-10-06.json): `5ddfd1a99841559c9293fe9795abcf645ec95ff0a116595d9cc47a2a0aa00ab3`
- [`run-3`](T7-react-profiler-component-dev-run-3-2026-10-06.json): `4dda2bee09aff09a7e10df474f59f6eb71a9311b175f53a2e4d4d7f4965e0d2b`

CLI stdout was not saved to separate `.log` files; no additional Electron runs were made to manufacture logs.

## Measurements

The table reports median `actualDuration` summed by component ID across its Profiler instances for each action. The component sum is nested inside the `CanvasWorkspace` total; do not add it to the parent total. Values are rounded to 0.1 ms.

| Action | CanvasWorkspace | Module nodes | Group nodes | Smoothstep edges | Module panel | Connection panel |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial render | 47.4 ms | 3.7 ms | 1.5 ms | 1.0 ms | — | — |
| Expand group | 40.6 ms | 4.3 ms | 5.1 ms | 0.5 ms | — | — |
| Collapse group | 24.3 ms | 2.7 ms | 1.6 ms | 0.3 ms | — | — |
| Filter technology | 5.5 ms | 0.4 ms | 0.2 ms | 0.0 ms | — | — |
| Automatic layout refresh | 15.3 ms | 0.0 ms | 0.0 ms | 0.0 ms | — | — |
| Select module | 18.4 ms | 5.2 ms | 0.0 ms | 0.6 ms | 5.1 ms | — |
| Select edge | 1.9 ms | 0.5 ms | 0.0 ms | 0.1 ms | — | 3.3 ms |

The existing single-run `CanvasWorkspace`-only baseline for the same five actions is 60.1, 33.6, 18.4, 6.1, and 22.6 ms respectively. Root Profiler timings in this report were filtered by `componentId === "CanvasWorkspace"`; the smoke action totals include nested component samples and are not comparable to that baseline. Root commit counts for expand, collapse, and filter matched the prior 15, 28, and 4; initial and layout counts varied across runs.

This confirms that component-level timing can be collected safely and repeatably on the synthetic fixture. It does not establish a performance pass: the baseline is a single older DEV run, instrumentation and source have since changed, the fixture is not a large-graph stress case, and no performance budget is frozen. The sampled node, edge, and panel subtrees did not show a stable dominant hotspot in these runs, so this evidence does not justify speculative memoization or Zustand subscription changes. T7 remains open for the plan’s full evidence requirements, including packaged keyboard focus/Tab-order and human visual review.

The earlier [`component-dev` capture](T7-react-profiler-component-dev-2026-10-06.json) is retained as the first probe, but excluded from these measurements because an empty detail-panel Profiler boundary recorded extra commits before a panel was selected. The boundary now returns its children directly when the panel is absent.

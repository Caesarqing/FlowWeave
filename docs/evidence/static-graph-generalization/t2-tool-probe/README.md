# T2 isolated analyzer probe

Run date: 2026-10-06. This is a synthetic smoke probe, not one of the real project comparisons required by T2. It did not inspect user projects or holdouts, and it does not contain human labels or support an adoption decision.

The probe ran on Node v24.6.0, npm 11.5.1, macOS arm64. Candidates were installed outside the repository with scripts disabled:

```sh
npm install --prefix /tmp/flowweave-t2-probe.NktDoh --ignore-scripts --no-audit --no-fund dependency-cruiser@18.5.0 graphology@0.26.0 graphology-communities-louvain@2.0.2
```

TypeScript fixture check and import analysis:

```sh
cd fixtures/typescript
../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --strict
npm_config_offline=true ../../node_modules/.bin/depcruise --no-config --ts-config tsconfig.json --output-type json src
```

The result is `dependency-cruiser-typescript.json`: 3 files and 2 dependency edges. It resolves the `@core/*` TS path alias and an `export` re-export. It reports imports, not call sites or confirmed calls. Running dependency-cruiser over the Python dynamic-attribute fixture yields zero modules (`dependency-cruiser-python.json`); this is an unsupported-language result, not a successful Python analysis.

Graphology Louvain was run over those extracted edges:

```sh
cd fixtures/typescript
node ../../graphology-from-dependencies.cjs
```

`graphology-louvain-typescript.json` places all three nodes in one community. Graphology consumes a graph object; this result says nothing about source parsing or module responsibility quality.

Java and Go tool probes failed before indexing. The environment has no Java/JDK, Maven, Gradle, Go, `gopls`, `scip-go`, SCIP-Java, or `callgraph` executable; Docker is installed but its daemon is stopped. Exact command output and exit codes are in `commands.json`. The Java and Go samples are included only to make the attempted scenarios explicit; no SCIP result was produced. The SCIP-Java documentation requires JDK 17 or newer and describes automatic indexing for Maven/Gradle/Bazel, while its convenience Docker image includes multiple JDKs and downloads project dependencies during indexing. The SCIP-Go quick start installs via `go install` and invokes Go tooling. See the official [SCIP-Java setup](https://github.com/scip-code/scip-java/blob/main/docs/getting-started.md), [SCIP-Go README](https://github.com/scip-code/scip-go), [dependency-cruiser options](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md), and [Graphology overview](https://github.com/graphology/graphology).

Registry metadata in `commands.json` reports MIT licenses and unpacked sizes of 1,045,643 bytes for dependency-cruiser 18.5.0, 2,729,833 bytes for Graphology 0.26.0, and 47,416 bytes for graphology-communities-louvain 2.0.2. Their temporary installed directories used approximately 1.6 MB, 2.7 MB, and 64 KB; no native `.node` binaries were found. The combined temporary install was about 12 MB. Only these three direct package licenses were checked; transitive notices/licenses, real-project quality, call accuracy, Java overload resolution, Go interface dispatch, arm64 release distributions, and default-build integration remain unverified.

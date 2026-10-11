# T1a development manifest integrity — 2026-10-08

This read-only audit checked the current development records in `corpus.json` against their pinned checkouts and `development-inventory-summary.json`. It did not run repository code or inspect any holdout checkout, source, analyzer output, run result, or label.

The raw corpus SHA-256 is `8cdeb59d92a2326bf38c680517af481b031624869063fdfdc66afbf40ba3fcc7`. All ten development checkouts matched their registered commit and tree and had clean tracked and untracked state. For every combined JSONL inventory, the raw manifest hash matched both registry and summary; each listed file's path, Git mode, byte size, and SHA-256 matched the pinned checkout; the normalized include/exclude scope hash matched the registered value; and source counts, byte totals, and language counts matched the registry.

| Sample | Inventory rows | Source files |
| --- | ---: | ---: |
| D01 | 260 | 232 |
| D02 | 525 | 505 |
| D03 | 26 | 24 |
| D04 | 80 | 78 |
| D05 | 102 | 96 |
| D07 | 21 | 19 |
| D08 | 37 | 35 |
| H03 | 618 | 612 |
| D09 | 4,569 | 4,541 |
| D10 | 716 | 712 |
| **Total** | **6,954** | **6,854** |

The source total is 42,222,539 bytes: 1,183 TypeScript, 102 Python, 5,249 Java, and 320 Go files. The scope hash calculation uses the same normalized, sorted include/exclude paths and JSON encoding as `collectionScopeSha256` in `scripts/run-static-graph-acceptance.ts`.

This confirms integrity of the current development manifests only. It does not freeze sample scopes, complete embedded/transitive source and license provenance, assign accountable human acquisition owners, provide the required reviewers or holdout custodian, or produce baseline measurements. The corpus and scopes remain proposed; no T1a completion checkbox is satisfied by this check alone.

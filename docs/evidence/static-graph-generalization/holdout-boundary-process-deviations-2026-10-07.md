# Holdout boundary process deviations — 2026-10-07

Status: process disclosure only. No holdout analysis, labels, or performance results were read or generated.

Two context-gathering steps exposed holdout scope metadata to implementation agents:

1. During a development-only D02 audit, a subagent read the full T1a scope-review document and encountered a row describing holdout scope. The subagent did not open any holdout checkout or inspect its sources, labels, analyzer output, or performance results. Its D02 font inventory was independently regenerated from the registered development checkout.
2. During this continuation, the primary agent requested a broad text dump of the baseline context and run configuration. The output included paths identifying the holdout checkouts. The primary agent did not open or run any of those checkouts and did not read their source, labels, analysis output, or performance results.

The exposure means the implementation agents have seen holdout identity metadata. No identity values are repeated here. Do not treat identity secrecy from implementation agents as intact. Keep subsequent implementation and comparisons limited to development checkouts and synthetic boundary fixtures. Before a future independent holdout run, the separate custodian must decide whether to establish a fresh sealed holdout set and record its identity and custody process without disclosing it to implementation agents.

This note records a boundary deviation; it is not evidence that any holdout result was evaluated, and it does not authorize opening holdout data.

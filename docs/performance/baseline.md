# Orchestration scalability baseline

Status: **no measured application-performance baseline yet**. The benchmark
runner honestly returned ENVIRONMENT_SKIP because compiled dist was absent.
The checked-in JSON report has no measured cases; missing values are not zero.
No latency improvement, throughput claim or before/after optimization is made.

## Workload plan and implemented coverage

| Domain | Planned cardinalities | Current implementation |
| --- | --- | --- |
| Sessions | 100 / 1,000 / 10,000 | Deterministic descriptors only |
| Coordinator tasks | 100 / 1,000 / 10,000 | Four DAG generators and real store adapter |
| File intents | 1,000 / 10,000 / 100,000 | Disjoint/overlap and project/worktree descriptors |
| Alerts and due work | 1,000 / 10,000 each | Descriptors only |
| Integrations and handoffs | 100 / 1,000 / 10,000 each | Descriptors only |

The four DAG shapes are linear, wide, fan-in and fan-out. Generator tests
actually construct 100,000 distinct intent paths and check dense overlap and
project/worktree distributions. Generating descriptors does not seed the real
subsystems or measure their operations.

The current runner imports real `dist/coordinator-store.js`, creates an
isolated temporary database through supported APIs, and measures task list,
lookup and dependency resolution. It does not substitute a synthetic array
lookup for database performance. All temporary benchmark state is removed.
Manager-level ready discovery, conflict scanning, session health/events,
watchdog, automation, integration, handoff, supervisor and workspace-registry
adapters remain unimplemented and are explicitly listed in the JSON output.

## Running and interpreting results

After installing the pinned dependencies and completing the canonical build:

```text
node benchmarks/orchestration/run.mjs smoke benchmark-smoke.json
node benchmarks/orchestration/run.mjs full benchmark-full.json
```

Output files are created exclusively. Smoke uses 100 tasks in each DAG shape,
3 warmups and 30 samples. Full uses the three task sizes, all shapes, 3 warmups
and 100 samples. API latency and JSON serialization are measured separately.
The report includes nearest-rank p50/p95/p99/max, returned payload bytes,
sampled process RSS/heap and SQLite database/WAL sizes. Sampled memory is not
native peak memory. At 30 samples the upper percentiles have very low resolution.
Row-scan and query instrumentation are unavailable and reported as null, never
estimated as measured data. Functional assertions require expected task and
dependency counts; there is no fragile absolute latency threshold in unit CI.

The list operation intentionally uses the existing maximum of 500 returned
rows. A 10,000-task dataset is not evidence of full-result enumeration, manager
readiness completeness or total output-bounding behavior. Full benchmarking is
separate from normal unit tests. A complete machine baseline should capture
commit, OS/CPU/runtime, cold/warm assumptions, storage, raw samples and repeated
runs before assigning performance budgets; the present report is insufficient
for such budgets.

## Observed local result

Linux x64; Node v22.16.0; ABI 127; AMD EPYC 9V74 80-Core Processor with five
logical CPUs exposed. pnpm is unavailable and Node is below the repository's
minimum >=22.19. The application was not built in this environment.

| Measurement | Result |
| --- | --- |
| Real CoordinatorStore smoke | ENVIRONMENT_SKIP: dist/coordinator-store.js absent |
| p50 / p95 / p99 / max | Not measured |
| Application RSS / heap / payload / database / WAL | Not measured |
| Rows scanned / query count | Not instrumented |
| Full-scale runs and Windows baseline | Not run |
| Generator contracts | 8 tests passed in the standalone suite |

See `smoke.environment-skip.json` for the actual machine-readable result and
[CI coverage](../ci/coverage.md) for all verification boundaries.

## Source-derived finding, not timing evidence

At baseline `5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`,
`CoordinatorStore.listTasks()` maps each row through `taskFromRow()`, which
performs a dependency query. N returned tasks therefore cause 1 + N explicit
SQL statements in this path: up to 501 for the existing 500-row limit. This
count is derived from source, not profiler instrumentation. `createPlan()`
also rereads every inserted task through `getTask()` after its transaction.

Batching dependencies is a candidate optimization, but this branch does not
change the store owned by the parallel reliability work. Before/after latency,
query counts, ordering and complete graph semantics must be measured and
regression-tested there. See [follow-ups](../scale-release-followups.md).

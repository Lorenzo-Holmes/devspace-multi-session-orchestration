# Scale/release follow-ups and parallel-branch boundary

Base audited: `5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`.
This branch deliberately does not modify production orchestration, migration,
workspace-access or existing correctness-test files. No changed tool semantics
or unmeasured optimization is presented as completed work.

## Core performance work reserved for reliability coordination

| Location | Source finding or unresolved question | Required follow-up |
| --- | --- | --- |
| coordinator-store.ts: listTasks / taskFromRow | One list query plus dependency query per row; source-derived maximum 501 statements for 500 rows | Batch scoped dependency reads with stable ordering; measure statement counts and latency; preserve all correctness assertions |
| coordinator-store.ts: createPlan / getTask | Post-insert rereads scale with every inserted task | Benchmark creation separately and evaluate batch hydration without changing atomicity |
| orchestration-coordinator.ts: ready discovery | Complete traversal beyond list bounds is not established by this branch's store benchmark | Add adversarial large-graph completeness tests; do not optimize by truncating the graph |
| registry/store/conflict, watchdog, automation, integration, handoff, supervisor, workspace registry | Complete scale adapters and query/row instrumentation are missing | Add supported-API fixtures, real operations, functional bounds and measured baselines; do not label generic descriptors as subsystem coverage |

Only the first two rows are directly identified source patterns. The others
are unverified coverage requirements, not claims that a runtime defect was
reproduced. No before/after speedup has been measured.

## Release integration and deploy safety

The sidecar library is opt-in, not automatically mandatory in the production
deploy guard. Integrate trustworthy exact-candidate catalog collection,
source/dirty status, independently retained manifest hash, clean build
provenance and pre-switch verification before using it as a release gate.
No cryptographic attestation or filesystem immutability is implemented.

The unchanged deploy guard needs a versioned contract for coordinator leases,
managed-worktree provisioning, integration/test activity and pending
automation deliveries before extending drain decisions. Agree on actual
persisted tables/states with the reliability branch; never invent fields or
apply a guessed future migration. The offline rollback helper does not assert
that any of this activity is drained, that runtime health is good, or that a
live database can safely roll back.

## CI and packaged acceptance gaps

The attempted `.github/workflows/ci.yml` update was stopped by the tool safety
check. No GitHub HTTP permission denial was returned and no alternative route
was used to write the blocked workflow. The existing three-platform Node 22
workflow remains unchanged. Adding the new source test wrapper is ordinary
new regression coverage, not a replacement workflow or a benchmark job.

Node 24 jobs, explicit independent stages, always-retained sanitized evidence,
benchmark smoke jobs, complete script checks and portable packaged V2
acceptance provisioning remain pending workflow work. Existing packaged V2
coverage is present in `src/chat-card-http.test.ts` but environment-gated and
was skipped by the observed CI run. Do not remove skips without supplying the
required isolated runtime and dependencies.

## Observed CI failure requiring separate investigation

Run 35444001138 on head `ca9e415349c33dcf39c8f0c083128c3489938061`
used Node 22.23.2 and pnpm 11.25.0 on Ubuntu. Full-source tests ended with
307 total / 294 pass / 2 fail / 11 skip. The engineering wrapper passed.
The failed unchanged `src/server.test.ts` assertions were:

- Line 865: native desktop/browser tools should include `observe`.
- Line 922: `browser_state` should not return `isError: true` in the scoped mock test.

These are failures, not environment skips. This branch did not edit those
tests or server.ts, but an identical baseline run has not been established,
so they are not conclusively classified as pre-existing or unrelated. Diagnose
the fixture/registration contract without weakening the safety assertions.
The full build was skipped after failure and has no passing result here.

## CUA official runtime root

At the audited base, `discoverCodexCuaSidecar()` in `src/codex-cua-bridge.ts`
resolves launch paths and only permits the discovered plugin root. It does
not implement the separately requested official
`AppData/Local/OpenAI/Codex/runtimes/cua_node` allowance. No patch is claimed.
A follow-up must define trusted ownership, exact allowed root/entrypoint,
canonical real paths and symlink/junction containment, with positive and
negative Windows tests. Do not broadly allow arbitrary user-writable runtime
paths or assume this alone explains the two observed server tests.

## Completion criteria still unmet

A final release-ready change needs a green full suite and build on the final
commit, actual Windows 5.1/7 and Node 24 native execution, executed packaged V2
acceptance, a complete scale baseline, verified candidate and rollback
artifacts, and coordinated deploy-drain checks. Independent fixture success
is useful regression evidence but does not meet these criteria by itself.

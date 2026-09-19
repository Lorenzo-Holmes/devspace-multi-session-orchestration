# Reliability hardening implementation ledger

## Checkpoint: 2026-09-19

Overall status: **PARTIAL — not ready to authorize unattended session takeover**.

This ledger describes code actually present on `pro/v2.1-reliability-hardening`.
The initial remote head was `0cf912f400ec0835133aa50b0d30aaefe7af4c4e`;
its two commits above main changed CI only. Main was
`5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`.

## Implemented in this checkpoint

| Requirement | Implementation | Verification and limits |
| --- | --- | --- |
| A3 approval atomicity | Request revision/reservation precedes async verification. Temporary activation and approval/audit are atomic. Permanent prepared grants, managed-root authority and a durable configuration journal prevent a late file write from granting access. Revocation removes authority before cleanup; once-use restorations are generation-fenced. | Barrier concurrency, expiry, supersession, injected persistence/audit failure, independent SQLite managers and real JSONC reopen. Conservative administrative recovery is implemented; automatic runtime recovery and real process-kill acceptance are not certified. See `workspace-approval-recovery.md`. |
| A4 scheduler starvation | SQL eligibility and dependency predicates precede ordering; history remains bounded. Claim, completion and release predicates reject stale/expired leases and wrong-project owners. | Actual SQLite fixtures with 500, 1,000 and 5,000 historical completed tasks. Priority ordering is deterministic, not a proof of starvation freedom under an infinite arrival of higher-priority work. |
| A5 internal reconciliation | Complete project-scoped session/task/V2 reads; complete watchdog and automation reconciliation; independent source/output completeness; Supervisor counts use complete inputs. Latest test observations use a kind-filtered SQL query. | 501/1,001/5,000 historical alerts all reconcile despite a 200-row display limit. Integration gate's separate snapshot/evidence design is still outstanding. Complete reads are memory-resident: dense-conflict/resource-budget stress is not certified. |
| A6 episode semantics | Task revisions, alert episodes and source generations drive new delivery/episode identifiers. Old revision acknowledgements cannot consume a new episode. | Ready/claimed/ready and blocked/running/blocked cycles entirely between polls/scans. No claim of cross-conversation takeover fencing. |
| A9 mutation observations | Persist actual returned file/move/partial-write receipts before best-effort advisory intents. Normalize and deduplicate intent paths before the capacity check. Thrown mutations produce explicitly uncertain observations. | Full 200-intent projection cannot discard the mutation fact; old/new move paths and partial-write flags survive. This is not a filesystem-junction containment proof. |
| A12 session consistency | Session revision CAS, monotone activity timestamps, terminal-state protection, shared-connection transactions for state and required events. V2 change notifications are deferred until commit and discarded on rollback. | Two-connection stale-write checks and injected required-event failure. The new incarnation column is a foundation only; worker-restart/attempt ownership is not implemented by this checkpoint. |
| A15 migration | Append-only migration 19 adds session revision/incarnation/binding/mutation counters and a filtered-event lookup index. No old migration edited. | Reconstructed version-18 schema upgrades, injected migration-ledger failure rolls schema changes back, restart is idempotent. |

## Remaining merge blockers

- A1/A2: trusted TestRun lifecycle and execution-issued evidence are **not implemented**.
  A tool patch adding the execution-observation/validation journal was blocked by the
  platform safety check: `OpenAI could not determine the request's safety status`.
  It was not retried through another tool, command, encoding, or path. Neither
  proposed file exists. Unconnected validation tables/health changes were withdrawn.
  Existing command-keyword telemetry, running-process false-pass risk and caller-
  supplied integration evidence remain known issues; tests below do not certify them.
- A3 follow-up: wire conservative journal recovery to the canonical runtime lifecycle;
  retain `recovery_uncertain` when an external writer's final state cannot be established.
- A7/A8: generation-fenced integration evaluation and actual candidate/target merge simulation.
- A10/A11/A13: full project/logical-session/worker/attempt identities, worktree operation
  recovery and authoritative attempt-level fencing.
- A14: handle-level/junction/directory-replacement filesystem containment.
- A16: full multi-process, crash and resource-exhaustion campaigns; current tests are
  focused regression tests, not a complete adversarial acceptance certificate.

The blocked execution-journal action does not authorize bypassing a security guard.
Independent work may proceed, but automatic rollover must remain disabled until its
reliability prerequisites and real-browser safety requirements are satisfied.

## Validation truth

Environment: Windows, Node **24.19.0**, pnpm **11.25.0**, SQLite native module rebuilt
for Node ABI **137**. The isolated checkout is on exFAT.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` with the default symlink layout | BLOCKED: exFAT cannot create the required links |
| `pnpm install --frozen-lockfile --config.node-linker=hoisted` | PASS |
| `pnpm --config.node-linker=hoisted rebuild better-sqlite3` plus a real in-memory query | PASS |
| Focused command below, expanded with workspace approval and OAuth regression files | PASS: 51 tests, 0 failed, 0 skipped |
| `pnpm --config.node-linker=hoisted typecheck` | PASS |
| `git diff --check` | PASS |
| Full repository test suite at `33fb2b4188da8cd99f1962c881f3254b037c1205` | FAIL: 324 total, 310 passed, 1 failed, 13 skipped. The failure was the OAuth store test's obsolete exact migration list (18 entries); the assertion now includes migrations 19 and 20 and its focused rerun passes. Full rerun of this newer checkpoint is pending. |
| Full build at `33fb2b4188da8cd99f1962c881f3254b037c1205` | PASS; Vite reported large-chunk warnings. Newer checkpoint build is pending. |
| Real Browser/ChatGPT rollover | NOT RUN; prerequisite blocked |

Set `npm_config_node_linker=hoisted` for subsequent pnpm commands on exFAT so its
implicit dependency check does not switch back to the unsupported link layout.
Use an installed supported Node runtime; no global Node or repository lockfile
change is required for this environment adjustment.

```text
pnpm --config.node-linker=hoisted exec tsx --test --test-concurrency=1
  src/coordinator-reliability.test.ts
  src/session-consistency.test.ts
  src/session-migration.test.ts
  src/reconciliation-reliability.test.ts
  src/orchestration-coordinator.test.ts
  src/orchestration-registry.test.ts
  src/orchestration-automation.test.ts
  src/orchestration-watchdog.test.ts
  src/orchestration-supervisor.test.ts
  src/workspace-approval-reliability.test.ts
  src/workspace-access.test.ts
  src/oauth-store.test.ts
```

Earlier attempts are not counted as passes: an implicit pnpm reinstall failed on
exFAT; a subsequent run failed all 15 setup operations due to a cached Node-22
native SQLite binary; one later test failed during Windows cleanup because a
fixture connection was still open. The native module and test cleanup were
corrected, then the initial 29-test command passed with zero skips. After the
approval implementation, an intermediate 21-test command also passed. A later
combined command lost its process receipt when the external DevSpace service
restarted (reported start changed to `2026-09-19T14:55:58.618Z`); that attempt is
**UNKNOWN**, not PASS. The complete current 51-test command was then rerun and
passed with zero skips, typecheck exit 0 and diff-check exit 0. Test output and
exit receipts for that rerun were retained in the isolated checkout's Git
metadata directory, not in user application data.

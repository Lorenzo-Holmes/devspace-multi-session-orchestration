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
- A3: approval reservation, cross-config durable recovery and approval/revocation races.
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
| Focused command below | PASS: 29 tests, 0 failed, 0 skipped |
| `pnpm --config.node-linker=hoisted typecheck` | PASS |
| `git diff --check` | PASS |
| Full repository test suite | NOT RUN at this checkpoint |
| Full build | NOT RUN at this checkpoint |
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
```

Earlier attempts are not counted as passes: an implicit pnpm reinstall failed on
exFAT; a subsequent run failed all 15 setup operations due to a cached Node-22
native SQLite binary; one later test failed during Windows cleanup because a
fixture connection was still open. The native module and test cleanup were
corrected, then the complete 29-test command above passed with zero skips.

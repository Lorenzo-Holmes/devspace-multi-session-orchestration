# Reliability hardening implementation ledger

## Checkpoint: 2026-09-20

Overall status: **PARTIAL — not ready to authorize unattended session takeover**.

This ledger describes code actually present on `pro/v2.1-reliability-hardening`.
The initial remote head was `0cf912f400ec0835133aa50b0d30aaefe7af4c4e`;
its two commits above main changed CI only. Main was
`5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`.

## Implemented in this checkpoint

| Requirement | Implementation | Verification and limits |
| --- | --- | --- |
| A1/A2 TestRun + trusted Evidence | Durable TestRun lifecycle with `started/running/passed/failed/cancelled/unknown`; stable process identity and timeout/cancel facts; source commit/tree and environment identity capture; successful runs alone issue scoped Evidence IDs. Integration no longer accepts caller-selected event/commit pairs. Health separates attempts, successful validation and failures. | Focused lifecycle, process, migration, real server telemetry and stale-commit evidence regressions pass. `node --test --help` and keyword-only commands do not validate; exit 0 without a positive test receipt remains unknown. Full repository rerun for this checkpoint is pending. |
| A3 approval atomicity | Request revision/reservation precedes async verification. Temporary activation and approval/audit are atomic. Permanent prepared grants, managed-root authority and a durable configuration journal prevent a late file write from granting access. Revocation removes authority before cleanup; once-use restorations are generation-fenced. | Barrier concurrency, expiry, supersession, injected persistence/audit failure, independent SQLite managers and real JSONC reopen. Conservative administrative recovery is implemented; automatic runtime recovery and real process-kill acceptance are not certified. See `workspace-approval-recovery.md`. |
| A4 scheduler starvation | SQL eligibility and dependency predicates precede ordering; history remains bounded. Claim, completion and release predicates reject stale/expired leases and wrong-project owners. | Actual SQLite fixtures with 500, 1,000 and 5,000 historical completed tasks. Priority ordering is deterministic, not a proof of starvation freedom under an infinite arrival of higher-priority work. |
| A5 internal reconciliation | Complete project-scoped session/task/V2 reads; complete watchdog and automation reconciliation; independent source/output completeness; Supervisor counts use complete inputs. Latest test observations use a kind-filtered SQL query. | 501/1,001/5,000 historical alerts all reconcile despite a 200-row display limit. Integration gate's separate snapshot/evidence design is still outstanding. Complete reads are memory-resident: dense-conflict/resource-budget stress is not certified. |
| A6 episode semantics | Task revisions, alert episodes and source generations drive new delivery/episode identifiers. Old revision acknowledgements cannot consume a new episode. | Ready/claimed/ready and blocked/running/blocked cycles entirely between polls/scans. No claim of cross-conversation takeover fencing. |
| A7/A8 integration generation + merge truth | Gate evaluation reserves a generation before async Git work, captures task/session/binding/OIDs/policy, then revalidates before publication. Candidate/target compatibility uses an isolated real merge simulation rather than index state. | Same-line, rename/delete, delete/modify, binary, moving target, stale review/task/session/binding and custom Git-helper cases pass. |
| A9 mutation observations | Persist actual returned file/move/partial-write receipts before best-effort advisory intents. Normalize and deduplicate intent paths before the capacity check. Thrown mutations produce explicitly uncertain observations. | Full 200-intent projection cannot discard the mutation fact; old/new move paths and partial-write flags survive. This is not a filesystem-junction containment proof. |
| A10 logical session / worker / attempt model | Persisted sessions now have a workspace-independent `logicalSessionId` and a separately replaceable `workerIncarnationId`. Coordinator claims issue unique `attemptId` plus monotone `leaseGeneration`; the existing durable worktree binding is the workspace binding. | Source → worktree → source keeps logical identity; worker restart changes only worker incarnation; release/reclaim changes attempt and generation. |
| A11 worktree crash recovery | Worktree prepare resolves `baseRef` to immutable `baseOid` and deterministic expected path before creation. Binding records operation/attempt/worker/generation and phases `reserved → git_created → workspace_registered → binding_active`; uncertain existing paths are quarantined, never deleted. Persisted managed workspace sessions are reused on recovery. | Crash-shaped fixtures cover reservation, Git-created/workspace-registered recovery, source HEAD moving after reservation, and quarantine preservation. Real process-kill injection remains part of A16. |
| A12 session consistency | Session revision CAS, monotone activity timestamps, terminal-state protection, shared-connection transactions for state and required events. V2 change notifications are deferred until commit and discarded on rollback. | Two-connection stale-write checks and injected required-event failure. Worker incarnation now has an explicit CAS transition/event. |
| A13 attempt-level fencing | Coordinator completion/release require the current worker incarnation. TestRun binds to the current coordinator attempt when present; evidence carries task/attempt/lease generation. Worktree, integration and handoff compare current attempt/worker/binding generations before becoming authoritative. | Old-worker completion and old-attempt validation are rejected in focused tests; integration keeps candidate/evidence/attempt alignment. |
| A14 filesystem containment (partial) | Read/list/search/file-info and `apply_patch` already canonicalize containment. Claude-compatible write/edit now reject outside absolute/traversal paths, escaping intermediate symlinks/junctions and final symlink targets. Shell semantics are unchanged. | Windows junction, traversal, outside absolute and final-symlink regressions pass. A malicious external directory-replacement race cannot be proven handle-safe with current Node path APIs and remains a blocker. |
| A15 migration | Append-only migrations 19–22 add session revision/incarnation/binding/mutation counters, approval journal state, TestRun/Evidence, logical/worker identity and coordinator attempt fencing fields. No old migration edited. | Reconstructed version-18 schema upgrades through version 22, injected migration-ledger failure rolls schema changes back, restart is idempotent. |

## Remaining merge blockers

- A3 follow-up: wire conservative journal recovery to the canonical runtime lifecycle;
  retain `recovery_uncertain` when an external writer's final state cannot be established.
- A14: canonical containment is substantially improved, but external concurrent
  directory replacement is not a handle-level proof on the current Node filesystem API.
- A16: full multi-process, crash and resource-exhaustion campaigns; current tests are
  focused regression tests, not a complete adversarial acceptance certificate.

Automatic rollover must remain disabled until the remaining identity, crash-recovery,
containment and adversarial reliability prerequisites plus real-browser safety
requirements are satisfied.

## Validation truth

Environment: Windows, Node **24.19.0**, pnpm **11.25.0**, SQLite native module rebuilt
for Node ABI **137**. Validation below is for the current isolated hardening worktree.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| Trusted validation / merge / process / migration focused suite | PASS: 25 tests, 0 failed, 0 skipped |
| Real MCP server automatic-telemetry regression | PASS: `node --test --help` produces no validation; a real one-test command produces execution-observed evidence |
| `pnpm typecheck` | PASS |
| `git diff --check` | PASS |
| Full repository `pnpm test` at remote `2ddb6d9` | PASS: 361 total, 348 passed, 0 failed, 13 skipped. The 13 skips remain **SKIP**, not PASS. |
| Post-`2ddb6d9` A10/A11/A13/A14 focused delta | PASS: logical/worker/attempt fencing, crash-shaped worktree recovery, migration 22 and filesystem containment suites; no skips in these focused runs. Full rerun for this delta is pending. |
| `pnpm build` | PASS; Vite reports existing large-chunk warnings. |
| Real Browser/ChatGPT rollover | NOT RUN; A14 handle-race certification and A16 adversarial acceptance still block unattended takeover |

An earlier full-suite attempt is not counted: it ran with the host's unsupported
Node 22.17 and a Node-24 native SQLite binary, causing ABI setup failures. The
current receipts use the verified Node 24.19.0 toolchain. Another intermediate
run correctly exposed two obsolete tests (migration list and legacy caller-declared
test success); both were updated to the new trust semantics before the successful
361-test rerun.

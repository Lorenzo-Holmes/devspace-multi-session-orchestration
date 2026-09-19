# Multi-session orchestration V2

DevSpace persists project coordination metadata. The host remains the orchestrator. No V2 component creates ChatGPT/Codex sessions, launches models, executes coordinator tasks, merges code, or changes filesystem permissions.

## Workflow

1. Open a project, create a coordinator DAG, and claim a task with session, revision and lease token.
2. Call `worktree_provision` from the repository root with that lease. It reuses WorkspaceRegistry and detached managed worktrees. The dirty source stays untouched; a worktree starts at the committed base, not a copy of uncommitted source edits. Persisted task identity makes retries recover the same managed directory. Existing bindings cannot be reassigned to another session. A session may own one active task worktree; provisioning explicitly binds its physical workspace and clears intents for the previous workspace without updating activity or heartbeat. Use the returned workspace for worker activity. `worktree_cleanup_status` only marks terminal-task eligibility; deletion is outside this workflow.
3. The host performs the work using normal workspace tools. Record test outcomes, complete the task, then create/update an integration record. Evidence references durable `test_run` event IDs and the tested commit. `integration_gate` inspects current Git state and saves a timestamped snapshot. Commit availability, nonempty diff, clean worktree, successful evidence, no unresolved overlap, task readiness and explicit review approval are required for merge-ready. A snapshot never performs or authorizes a merge by itself. Evidence associations supplied by the caller are metadata, not cryptographic CI attestation.
4. Session events, coordinator changes and integration updates trigger best-effort watchdog evaluation. Elapsed time alone requires `watchdog_scan` or scheduler polling. Alerts deduplicate, acknowledge and resolve/reopen as conditions change. Scans never repair anything and never serve as worker-alive proof.
5. `handoff_create` stores a bounded checkpoint; the receiving session uses `handoff_ack`. No message is sent to another conversation. `project_memory_update` stores only explicitly supplied fields using revision CAS (0 for first creation).
6. `supervisor_summary` is a read-only snapshot with a self-contained MCP App resource. It does not heartbeat, scan alerts or touch workspace activity. Expandable session timelines show up to ten persisted events; task timelines show creation and the current durable state timestamp, not a reconstructed history of every past lease.

## External scheduler hooks

Configure an external scheduler using its own supported scheduling facilities and an already authorized DevSpace MCP connection. V2 does not create that scheduler or a background model turn.

At each permitted run, call `automation_poll` with `workspaceId`, `limit` (1–200) and optional `after` cursor. Repeated polls with unchanged sources retain the same notification IDs and revisions. Notifications cover available tasks, integration review snapshots, open watchdog alerts (including stalled sessions and conflicts), pending handoffs and changes to the latest durable test event. Follow `nextCursor`, including on empty filtered pages. `automation_due_list` reads existing notifications without scanning.

Deliver or handle only relevant due records according to the external scheduler's explicit user authorization. After successful handling, call `automation_ack` with `notificationId`, the returned `expectedRevision` and a stable `consumer` name. Retry those exact acknowledgement arguments on an uncertain response. A newer source event invalidates stale acknowledgements. Delivery is at least once: the external scheduler should deduplicate on notification ID plus revision. Acknowledgements are project-global, not an independent queue per consumer. Stay quiet when state is unchanged or non-actionable.

No hook calls ChatGPT, starts a model, creates a thread, executes a task, retries commands, kills a process or merges changes. Integrating a host's official session-spawn API remains a separate future project if such an API becomes available.

## Bounds and persistence

SQLite migrations 13–18 add worktree bindings, integration records, watchdog alerts, handoff checkpoints, project memory and automation due work. Records carry project scope, revision and timestamps. Handoffs are limited to 64 KiB, project memory to 128 KiB, and supervisor output to 128 KiB with at most 50 rows per section and ten events per session. Ordinary list tools use bounded cursor pagination. Scans inspect at most 500 records per collection; `truncated` indicates partial coverage and incomplete scans do not clear unseen conditions. Large-project full scans and notification delivery guarantees beyond at-least-once polling are future work.

The database migration path is additive. Old immutable releases remain intact for rollback; no down-migration or destructive cleanup runs automatically. Managed worktree recovery refuses a changed original base or a mismatched repository and preserves the directory for review.

# Review Brief - DevSpace Multi-Session Orchestration V2

This repository is a clean public snapshot prepared for independent architecture/code review. It intentionally excludes local Git history, runtime databases, credentials, deployment evidence, generated build output, node_modules, temporary files, and local test artifacts.

## Current implementation

- automatic trusted session telemetry
- durable session registry and health/events
- coordinator task DAG with revision/lease fencing
- managed worktree isolation
- integration gating without automatic merge
- event-driven watchdog alerts
- cross-session handoff checkpoints
- revisioned project objective/memory
- read-only supervisor dashboard
- scheduler-facing automation poll/list/ack hooks
- Goal/card/Computer Use and filesystem/search infrastructure

## Production verification from the source workspace

- release: chat-goal-card-preview-20260919-04
- tool schema: 2026-09-19.4
- server: 0.1.0+tools.20260919.4
- server tool catalog: 84 total, 78 model-visible, 6 App-only
- full test run: 306 total / 303 pass / 0 fail / 3 platform-conditional skips
- packaged acceptance: 9 / 9 pass
- TypeScript typecheck: pass
- production build: pass

These values are review context only; deployment state and local databases are not included in this public snapshot.

## Important architectural boundaries

- No automatic ChatGPT/Codex session spawning.
- No background model executor.
- No automatic merge/rebase/cherry-pick/push.
- No automatic worktree deletion.
- Heartbeats do not prove a model is alive and cannot wake a turn.
- Watchdog alerts are observational and do not perform recovery.
- Integration manager reports gates/merge-readiness but does not merge.
- Automation hooks expose durable due-work records for an external scheduler; they do not invoke models.

## Review requested

Please perform an independent review rather than assuming the current design is optimal. Focus on:

1. Architecture correctness and unnecessary coupling.
2. Concurrency, lease fencing, CAS, idempotency, and restart recovery.
3. Security boundaries: project scoping, workspace authorization, path containment, OAuth/client binding, and App-only vs model-visible tools.
4. Multi-session telemetry correctness and false-liveness risks.
5. Managed worktree lifecycle, conflict detection, and dirty-source semantics.
6. Integration gate freshness and TOCTOU risks.
7. Watchdog alert deduplication, starvation, and large-project behavior.
8. Handoff semantics and stale receiver/task state.
9. Project-memory mutation model and revision discipline.
10. Supervisor dashboard read-only guarantees and bounded output.
11. Automation poll/ack delivery semantics and multiple-consumer behavior.
12. Test quality: missing adversarial, property, concurrency, crash-recovery, and security tests.
13. Performance/scalability bottlenecks, especially current bounded scans.
14. API/tool naming and whether the model-facing surface is too broad.
15. Specific refactors that reduce complexity without weakening safety.
16. Concrete V3 extension roadmap, ordered by dependency and risk.

Please distinguish confirmed bugs, design risks, maintainability issues, performance concerns, optional improvements, and future extensions.

For each important issue, cite the exact file/function and propose a concrete fix or test.

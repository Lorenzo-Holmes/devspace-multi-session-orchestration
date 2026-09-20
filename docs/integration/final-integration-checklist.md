# DevSpace final integration checklist

Nothing in this checklist authorizes merging a red PR, treating SKIP as PASS, or
bypassing Browser/OAuth/Computer-Use approval. Re-run against the exact head SHA
after every rebase.

## Global branch freeze

- [ ] Freeze production changes long enough to take a fresh `main`, `pro/*`,
      `codex/*`, and open-PR inventory.
- [ ] Restore **main CI to green on ubuntu, macOS and Windows** without disabling
      or skipping the failing assertions.
- [ ] Confirm supported Node/pnpm versions and native-module ABI in CI.
- [ ] Require install, typecheck, test, build, Doctor/release steps to produce
      explicit PASS/FAIL/SKIP receipts; no implicit success.

## A — Reliability gate (PR #5)

- [ ] Close or redesign the A14 external concurrent directory-replacement race
      with a handle-safe containment mechanism; direct junction/symlink fixes are
      not sufficient evidence for this last case.
- [ ] Wire conservative A3 approval-operation recovery into canonical runtime
      lifecycle where external persistence can remain uncertain.
- [x] Re-run old-DB → migration-22 upgrade, restart idempotence and migration
      failure rollback.
- [x] Re-run TestRun/Evidence false-positive matrix, attempt/worker fencing,
      worktree crash phases, 501/1001/5000 reconciliation and merge simulation.
- [x] Exact-head `9543127` GitHub Smoke is green on ubuntu, macOS and Windows for
      install, typecheck, test, build and Doctor. Local full test is 370 total /
      357 pass / 0 fail / 13 skip; `git diff --check` also passes. SKIP remains SKIP.

## G — Runtime resilience gate (PR #4)

- [ ] Rebase on merge-ready A.
- [ ] Preserve G as canonical runtime supervisor/CUA reconnect owner; no duplicate
      process/session authority.
- [ ] Validate restart/reconnect, journal concurrency, stale PID/pipe and Windows
      resume cases after A identity/fencing is present.
- [ ] Full CI green.

## F — Doctor gate (PR #7)

- [ ] Rebase on A+G.
- [ ] Re-run runtime/local/public MCP, catalog, Browser vs Computer, Windows tools,
      redaction and support-bundle tests against G's final runtime layout.
- [ ] UNKNOWN/SKIPPED remain distinct from PASS.
- [ ] CLI `doctor`, `--full`, `--json`, category and support bundle remain
      read-only and full CI is green.

## C — Control-plane gate (PR #1)

- [ ] Rebase on A+G.
- [ ] Refresh capability catalog/tool-schema fingerprints for A's `exec_command`
      and Integration Evidence schema changes.
- [ ] Verify Supervisor freshness/count completeness with A reconciliation.
- [ ] Full CI green.

## D — UI gate (PR #6)

- [ ] Rebase after C.
- [ ] Manually resolve `scripts/supervisor/card.html`: C owns data/semantic hooks;
      D owns shared visual tokens, hierarchy, motion and accessibility.
- [ ] Re-run visual contract, `build:chat-card`, full build, light/dark/narrow
      Playwright smoke, keyboard/focus/reduced-motion/a11y checks.
- [ ] Add deterministic golden screenshots only if the project decides to make
      pixel regression a required release gate.

## B — Scale/release gate (PR #3)

- [ ] Rebase onto the final production surface A+G+F+C+D.
- [ ] Re-run benchmarks with environment metadata; distinguish environment SKIP
      from performance PASS.
- [ ] Verify production build contract, packaged chat-card assets,
      reproducibility, preflight, release verification and rollback instructions.
- [ ] Full CI/release pipeline green before using B to ship the combined system.

## E — Auto Session Rollover gate (PR #2, stacked on A)

- [ ] Rebase onto latest A (currently 13 A-only commits behind).
- [ ] After A merges, retarget PR #2 from A to `main`.
- [ ] Implement durable ConversationEpoch and RolloverAttempt journal.
- [ ] Extend canonical handoff for context/recovery rollover; do not create a
      second authority model.
- [ ] Implement Browser-Use-only ConversationLauncher; Browser failure must not
      fall back to desktop automation.
- [ ] Implement checkpoint → new chat → bootstrap → verified handshake → atomic
      takeover → old-epoch fencing.
- [ ] Persist project opt-in, bounded retry/cooldown/global concurrency, and
      PAUSED_NEEDS_ATTENTION loop prevention.
- [ ] Crash-injection at every external-effect boundary proves at most one active
      epoch.
- [ ] Real Browser E2E passes or remains explicitly WAITING_USER/BLOCKED for
      login/MFA/approval. **Do not merge current preparatory E.**

## H — E2E / chaos gate

- [x] Draft PR #10 exists for the pushed `08a487d` head.
- [ ] Rebase on final production core.
- [ ] Replace old `testEvidence(eventId, commit)` journey setup with A trusted
      execution Evidence IDs.
- [ ] Keep environment truth labels: isolated E2E != real browser/remote MCP.
- [ ] Re-run DB/process/port/workspace/target-move/runtime/browser chaos as owners
      become available; retain findings for unresolved failures.

## J — Security gate (PR #8)

- [ ] Rebase on final production core.
- [ ] Convert SEC-001 Evidence forgery reproduction into a rejection regression.
- [ ] Convert SEC-002 junction escape reproduction into a containment rejection
      regression; keep the A14 handle-race caveat separate.
- [ ] Convert SEC-003 stale handoff reproduction into an attempt/worker-fencing
      rejection regression.
- [ ] Re-run cross-project, stale lease, Supervisor XSS, SQL scope, resource
      bounds, secrets and Browser-origin cases without touching real accounts.
- [ ] Full CI green.

## Final combined acceptance

- [ ] Fresh file-overlap matrix has no unresolved conflict.
- [ ] Migration numbers/names/content are unique and ordered; old DB upgrades.
- [ ] Live `tools/list` has no duplicate name/different schema and correct
      model/app visibility; catalog fingerprint matches host snapshot.
- [ ] No duplicate Browser adapter, process manager, session identity, runtime
      state machine or security classifier is active.
- [ ] Temporary combined merge is built and tested; no pushed merge commit is
      needed for the simulation.
- [ ] Windows local acceptance passes with Node/pnpm/native ABI recorded.
- [ ] Real Browser E2E, Computer approval and fixed-domain MCP are either PASS or
      explicitly BLOCKED/SKIP with the exact external reason.
- [ ] H/J acceptance/security suites pass on the exact combined production tree.
- [ ] B packaged release, reproducibility and rollback checks pass on that tree.
- [ ] Refresh `readiness-audit.md` with final heads and only then mark individual
      PRs READY_FOR_INTEGRATION.

## Cleanup after successful integration

- [ ] `codex/github-write-test` — candidate for deletion after confirming no
      audit/debug retention need; do not delete automatically.
- [ ] `codex/v2.1-hardening` — identical to old main and superseded by A;
      candidate for deletion after A lands; do not delete automatically.
- [ ] Remove only integration test worktrees/artifacts known to have been created
      by the integration process; never run broad reset/clean on user work.

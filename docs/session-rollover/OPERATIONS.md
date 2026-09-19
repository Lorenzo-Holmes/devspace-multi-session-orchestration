# Operations and enablement gate

## Current operational status

Automatic ChatGPT continuation is unavailable. The server imports none of the new helpers and has
no rollover timer, CLI command, MCP tool, recognized config field, migration or browser launcher.
Do not add `autoSessionRollover.enabled` to the existing server configuration and assume it works.
`rolloverPolicySchema.parse({ enabled: true })` only returns a validated in-memory policy value.

The branch deliberately implements the dependency-missing allowance from the engineering brief:
architecture, standalone policy, non-invasive helpers and tests without duplicate domain models.
No new LogicalSession, WorkerIncarnation, ExecutionAttempt or Handoff implementation is introduced.

## Verification commands

On a provisioned repository environment, use the actual package manager and locked dependencies:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
git diff --check
pnpm exec tsx --test --test-concurrency=1 'src/session-rollover/*.test.ts'
git diff --name-only pro/v2.1-reliability-hardening...HEAD
```

This container cannot resolve github.com and has no pnpm binary. Verification reuses the matching
existing GitHub Actions source/runtime artifacts, without modifying the workflow or installation.
Direct Node invocation of tsx/tsc and the four build steps is reported separately from `pnpm` success.
Exact measured results and baseline failures are in [TEST-MATRIX.md](TEST-MATRIX.md).

No real ChatGPT conversations were created; no credentials, approvals, user processes or dirty
workspaces were touched. The test runtime and build outputs are disposable local artifacts, not
changes to the user's running DevSpace installation.

## Requirements before eventual project opt-in

Canonical reliability models/fencing must be implemented and tested first. Then add scoped durable
policy storage and attempt/capacity reservations, incremental checkpoints and handoff extensions,
crash-safe Browser Use effects and authenticated receiver handshake, atomic takeover, late-write
rejection and a bounded lifecycle-managed controller. Prove unattended operation through the
supported host bridge; do not infer it from a foreground tool call succeeding.

A future dry-run must read the same policy, journal, safe-point and browser observations as execution
without opening a chat, reserving browser effects, sending a prompt or changing ownership. The present
pure helper evaluations are building blocks, not an operational `rollover trigger --dry-run` command.

## User interaction that remains mandatory

Initial project opt-in, new OAuth/browser/host/Computer Use authorization, login/MFA, wrong or unknown
account/workspace, unresolvable workspace/dirty-state mismatch, stale catalog without supported refresh,
unknown browser side effects and bounded-failure pause may require explicit human action. A denial
must never be retried through another transport. Approval resumption must revalidate current state.

## Parallel work and PR scope

Base the preparatory branch on the audited reliability SHA; the stacked PR targets reliability,
not main. Do not merge it automatically. Re-audit/rebase after reliability changes and retarget to main
only after reliability merges. Never advertise this preparation as the completed feature PR.

No CI/release/deploy/benchmark file, Supervisor semantics/tool taxonomy, shared visual system or
core reliability file is changed. Future extension points may require coordination with Pro A;
those integration edits are not smuggled into this prerequisite-only change.

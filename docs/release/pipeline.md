# Release pipeline: audited paths and current guarantees

Status: partial engineering hardening, not release acceptance. Audit baseline:
`5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`. The branch does not change
production orchestration, database migrations, or MCP tool contracts.

## Build and assembly

`package.json` owns the canonical build sequence:

```text
pnpm clean && pnpm build:app && pnpm build:chat-card && tsc -p tsconfig.build.json
```

`node scripts/build-production.mjs` delegates to that command rather than
implementing a second build. It checks the package engine and pinned pnpm,
plants a unique stale-dist marker, requires clean to remove it, and checks
server, CLI, supervisor and card HTML outputs. A changed package build contract
requires review instead of silently omitting a stage. Exit codes are 0 for
PASS, 1 for FAIL and 2 for ENVIRONMENT_SKIP.

The original `scripts/audit-build.mjs` ran Vite and TypeScript separately and
omitted clean and card assembly. It now delegates to this wrapper after its
existing typecheck and source-test stages. Its isolated Windows evidence path
is unchanged. No audit build was executed against that path in this work.

`prepare-chat-card-release.mjs` retains its fixed isolated Windows repository,
exclusive new candidate directory and no-overwrite behavior. It now requires
Node 24 and copies/hashes both regular dependency input files: `package.json`
and `pnpm-lock.yaml`. Existing dist/bin/schema/skills copying, server identity,
V2 assets and the legacy manifest format remain. It uses the existing shared
node_modules junction and never installs or rebuilds production dependencies.
The shared dependency target is not immutable.

Assembly still consumes an existing dist tree; it does not itself prove that
its source was clean or that a successful canonical build produced that tree.
The integrity sidecar is a separate opt-in sealing step. Automatic trusted
provenance capture and sealing inside assembly remain follow-ups.

## Artifact verification and acceptance are separate gates

`verify-release.mjs` and `release-contract.mjs` add a pinned integrity sidecar.
See [reproducibility.md](reproducibility.md) for commands and the trust boundary.
The verifier checks bytes, inventory, runtime identity and shared dependencies.
It does not start the packaged server or prove its behavior.

`src/chat-card-http.test.ts` already contains the authenticated packaged V2
integration test. It covers Coordinator, Worktree, Memory, Handoff,
Integration, Watchdog, Automation and the read-only Supervisor. The existing
fixture is gated by `DEVSPACE_CHAT_TEST_ROOT` and includes isolated Windows and
Shrimp runtime assumptions. Ordinary CI did not set that environment and the
observed Ubuntu run skipped this test. The missing coverage is execution and
portable fixture provisioning, not absence of a V2 test.

`scripts/test-chat-card-release.ps1` still selects the candidate dist entry,
checks legacy hashes and runs both packaged HTTP test files with restored
process environment afterward. It now explicitly imports
Microsoft.PowerShell.Utility before calling Get-FileHash. The separate
`test-release-preflight.ps1` parses release scripts and checks a known hash
without profiles or implicit module loading; this is not packaged acceptance.

## Deployment and rollback

The existing deploy guard remains unchanged. Its checks and protected-state
backups must not be equated with the new offline artifact verifier. Neither
this branch nor its tests switched a production pointer, stopped a service,
ran a production migration, or performed a real rollback.

The additive rollback snapshot verifies both candidate and rollback artifacts,
protected configuration digests, pointer metadata and conservative same-schema
compatibility. It never executes rollback. Future coordinator-lease, managed
worktree, integration and pending-delivery drain contracts need coordination
with the reliability branch; no future schema is guessed here.

The existing runtime probe now reports both name and definition fingerprints
and optionally checks an independently expected definition hash. It retains
its existing build-id, count and legacy name-hash assertions. It still targets
the configured production service and creates/revokes OAuth tokens, even
though its business tool calls are read-only. It was not run in this work and
must not be described as a side-effect-free offline check.

## Current verification boundary

See [CI coverage](../ci/coverage.md) and [benchmark baseline](../performance/baseline.md).
The observed remote full-suite run failed two existing CUA/browser assertions;
its build did not run. There is no all-green release readiness claim.

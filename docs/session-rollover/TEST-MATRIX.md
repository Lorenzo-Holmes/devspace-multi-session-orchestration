# Rollover preparation: verification and integration gates

## Measured results (2026-09-19)

Audited base: `0cf912f400ec0835133aa50b0d30aaefe7af4c4e`.
Environment: Linux, Node 22.23.2, installed locked dependencies from the existing
`hardening-runtime` artifact for run `35441499886`. Source bundle and artifact IDs
are recorded in [current-capabilities.md](current-capabilities.md).
No dependency, lockfile, package script, existing test or CI workflow was modified.

| Check | Result | Meaning |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | BLOCKED, exit 127 | `pnpm: command not found`; this sandbox cannot resolve external package/GitHub hosts. The existing CI-installed dependency artifact was used instead. This is NOT a successful fresh install here. |
| Baseline full suite, before added helpers/tests | 306 total / 289 pass / 6 fail / 11 skip | Exit 1; pre-existing failures documented below |
| Rollover focused suite | 142 total / 142 pass / 0 fail / 0 skip | Exit 0; pure helper tests only |
| Full suite with this change | 448 total / 431 pass / 6 fail / 11 skip | Exit 1; exactly the same six failing test names as baseline |
| TypeScript typecheck | PASS, exit 0 | Actual TypeScript entry point executed |
| Production build steps | PASS, exit 0 | Clean, Vite UI build, card packaging and build TypeScript compilation executed in package-script order |
| `git diff --check` and changed-path boundary | PASS | Only new `src/session-rollover/` and `docs/session-rollover/` files |
| Real Browser Use E2E | SKIP | Windows-only bridge, no authorized live browser in this environment, and canonical reliability/launcher integration absent |

The full suite is **not green**. Skips are not passes. No fake database, launcher or
controller is used to claim the missing production invariants have been verified.
The build emitted existing large-chunk warnings; those are not build failures.

## Commands actually executed

With the artifact's Node binary on PATH, the package test/typecheck/build entry points
were invoked directly because pnpm is unavailable. These are not reported as successful
`pnpm` invocations:

```sh
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 'src/**/*.test.ts'
node node_modules/tsx/dist/cli.mjs --test 'src/session-rollover/*.test.ts'
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"
node node_modules/vite/bin/vite.js build
node scripts/build-chat-card.mjs
node node_modules/typescript/bin/tsc -p tsconfig.build.json
git diff --cached --check
git diff --check
git diff --name-only pro/v2.1-reliability-hardening...HEAD
```

The full test run preceded the build, as in the requested verification sequence.
This environment's existing packaged/HTTP/platform skips must not be replaced by the
production snapshot counts in REVIEW_BRIEF.md. A provisioned native environment must
rerun `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.

## Baseline failures, reproduced without source changes

Four `search_files` tests fail:
- searches names and contents without allowing workspace escape;
- filters results by inclusive file size;
- filters by inclusive modified-time bounds;
- sorts text and structured matches deterministically.

Both `fd` and `fdfind` are absent. A direct `findFilesTool` probe returned
`fd is not available and could not be downloaded`. This sandbox cannot download the
binary. No substitute test implementation or changed assertion was introduced.

Two existing CUA tests fail:
- Computer Use exposes native desktop and trusted browser Codex CUA tools when the bridge is available;
- browser_state forwards real ChatGPT MCP scope as Codex Browser Use turn metadata.

`src/codex-cua-tools.ts:192` does not register those tools on non-Windows platforms;
`src/server.test.ts:859-929` asserts their presence with mocks in this Linux run.
These failures were already present on the exact audited base. This branch does not
change platform registration or another workstream's existing tests to mask them.

## Implemented focused coverage

| Area | What was exercised |
| --- | --- |
| Policy | Default off; strict bounded inputs; automatic/manual/recommended modes; recovery opt-in; supplied active-attempt coalescing; manual requests respect caps; failure pause; exact interval/cooldown boundaries; invalid/future/missing history |
| Context detector | Unknown vs observed zero; stale/future filtering; source attribution; bounded collection; deduplication; simultaneous conflict conservatism; age alone never recommends; heuristic confidence, not fabricated token usage |
| Error classifier | WebSocket/reset/timeout/DNS are transient; HTTP 408/429/5xx do not spawn a chat; explicit host context codes only; authentication/security/permission take precedence; untrusted message text ignored |
| Safe point | All nine checks require fresh observations; each busy/unknown/stale field blocks readiness; pending approval is explicit; future and malformed observations fail closed |
| Browser preflight | Exact browser/requested/provider tab binding; origin/userinfo/port/control-character failures; unavailable/denied/failed security; required approvals/login/MFA; wrong or unknown account/workspace; missing DevSpace; stale catalog; stale or incomplete snapshot |
| Bootstrap | Deterministic ordering/hash; compact fixed template; every ID affects fingerprint; bounded IDs and epoch; newline/control/injection rejection; extra capsule/history/secrets fields cannot enter template |
| Six-hour policy simulation | Virtual time bounds the number of eligible decisions to six; this is NOT a six-hour multi-epoch execution simulation |

These tests cover decision functions given data. They do not authenticate observation
provenance, implement durable coalescing or prove actual browser behavior.

## Required integration coverage: NOT IMPLEMENTED / NOT RUN

The following are blocked by canonical reliability models and the actual runtime adapter,
not counted as passing or hidden in the focused test total:

- ConversationEpoch persistence, single current epoch/worker and old-epoch mutation fencing.
- Checkpoint/capsule serialization, redaction, incremental persistence and Handoff integration.
- Rollover journal reservations; crash injection at every side effect and takeover boundary;
  restart at each phase; uncertain browser reconciliation; duplicate-storm prevention.
- Two DB connections/processes, simultaneous triggers, durable global/project capacity limits,
  takeover CAS and concurrent old-session writes/late results/acknowledgements.
- Project/session isolation, scoped handoff/memory loading, replayed/stale rollover IDs,
  authenticated receiver handshake and task/worktree/current-authority verification.
- Actual ConversationLauncher/FakeConversationLauncher lifecycle integration, background
  controller lifecycle and supported Browser Use without an active model turn.
- Old DB to new schema migration and migration restart recovery (no migration added here).
- Six-hour task continuity with decisions/checkpoints/generations and 100 epoch transitions.
- All ten end-to-end product acceptance scenarios in the engineering brief.

See [RECOVERY.md](RECOVERY.md) for the crash matrix and [SECURITY.md](SECURITY.md) for the
security acceptance gates that the later implementation must satisfy before leaving draft.

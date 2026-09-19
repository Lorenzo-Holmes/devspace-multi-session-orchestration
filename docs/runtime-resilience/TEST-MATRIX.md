# Runtime resilience test matrix and evidence

Validation date: 2026-09-19. This document is an evidence boundary, not a statement that the PR is ready to merge or deploy.

## Recorded executions

| Execution | Result | Scope |
| --- | --- | --- |
| Isolated TypeScript compilation | Passed | Local runtime harness with global TypeScript 5.8.3; not full project typecheck |
| Isolated runtime/reconnect/health/process suite | 93 tests: 92 passed, 0 failed, 1 skipped | Available Linux container, Node 22.16.0; Windows-only test skipped |
| Real isolated smoke | Passed | Actual worker, SQLite journal, Linux process identity, HTTP/MCP health, crash/restart, intentional stop and clean shutdown |
| Existing full-project CI, core commit `db973f1` | Install/typecheck passed on Ubuntu, macOS and Windows; tests failed | Build/doctor steps were skipped after test failure |
| Existing full-project CI, CUA commit `3ddebf9` | Typecheck passed on three platforms; overall validation not green | Do not interpret this as a passing full test/build gate |
| Five CUA facade integration tests | Added to repository test discovery | Not executed in the dependency-free local harness; require repository SDK/zod dependencies |

The local container lacked pnpm and could not resolve GitHub for cloning. Source editing used the GitHub connector; the isolated harness used only available dependencies. Its Node version was below the project's declared minimum, so local success does not replace supported-version CI. Harness configuration and generated output were not committed as replacements for repository configuration.

The initial Ubuntu CI failures included two unchanged `src/server.test.ts` expectations for CUA tools despite the existing Windows-only registration gate. This observation is not a baseline rerun and does not establish that every later/platform failure is pre-existing. No tool-registration security gate or CI requirement was relaxed to make the checks green. Remaining full-suite failures require resolution before merge; no production build pass is claimed.

## Regression coverage

| Area | Cases |
| --- | --- |
| Process identity | PID, birth and executable mismatch; owned listener; native refusal of reused identity |
| Ownership | Competing SQLite owners; two actual OS supervisors; stale owner fencing; uncertain owner retained |
| Atomicity | Transaction rollback; corrupt metadata preserved; subprocess exit during uncommitted write |
| Launch recovery | Worker registration before acknowledgement; lost acknowledgement; revoked late ticket; native publication gap blocked |
| Health | Process/port insufficient alone; JSON/SSE MCP; build/version/catalog mismatch; timeout/authentication/oversize rejection; own-session cleanup |
| Supervision | Crash/restart, startup timeout, unknown listener, no duplicate concurrent tick, stale health result fencing |
| Policy | Disabled recovery, backoff, rolling/global budget, crash-loop pause, sustained healthy reset |
| Controls | Persistent stop, pause/resume, drain-before-restart, upgrade stop without release change |
| Tunnel | Managed crash ordering; external ownership; remote outage without server restart |
| Clock | Two-hour sleep, backward clock, exact 24-hour accelerated mixed-fault simulation |
| Browser | Read-only reconnect, action non-replay, approval preservation, backpressure, budget and uncertain teardown fence |
| Authority | No user task-process termination and no fixture workspace-byte mutation |

The 24-hour case advances an injected clock through 86,400,000 ms; it is not a real 24-hour soak. Tests using fake adapters prove state-machine behavior, not host integration. The workspace fixture check is not a comprehensive security proof.

## Required before production acceptance

Resolve full-project test failures and obtain passing build/doctor/package acceptance on the final code. Exercise the Windows retained-handle backend and actual supported host permissions; perform real suspend/resume/reboot and intentional-stop tests. Validate the approved release's MCP health credential and actual catalog; validate managed/external tunnel ownership separately. Exercise real Codex/browser reconnection and approval boundaries. Verify packaging, immutable release handoff, private runtime ACLs, startup configuration, and no overlap with the existing production supervisor.

No production host, Cloudflare account, DNS, Codex process, browser profile or user task was altered for this validation. Keep the pull request draft until the outstanding gates are satisfied.

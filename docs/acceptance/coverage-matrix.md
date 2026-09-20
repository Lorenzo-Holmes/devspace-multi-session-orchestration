# DevSpace product-journey / chaos acceptance matrix

Date: 2026-09-20. H branch base: `main` at `5b0fefa`.

Status vocabulary is literal: PASS, FAIL, SKIP, BLOCKED, NOT_IMPLEMENTED.
A fake adapter or isolated fixture is never labeled a real local/browser/remote E2E.

| Journey / fault | Level | Status | Evidence / boundary |
| --- | --- | --- | --- |
| Workspace → managed worktree → edit → validation → integration → handoff → Supervisor | isolated E2E | PASS | `tests/e2e/product-journeys.test.ts`; real temp Git + SQLite |
| Multi-session → separate worktrees | isolated E2E | PASS | distinct real Git worktree paths and file isolation |
| Coordinator DAG | isolated E2E | PASS | dependency not ready before parent completion; ready afterwards |
| Worktree lifecycle + restart persistence | isolated E2E | PASS | V2 reopen verifies integration/handoff durable state |
| Integration gate | isolated E2E | PASS on main semantics | target movement correctness is owned by A; see finding E2E-001 |
| Watchdog / Automation | integration | PASS (bounded) | automation poll runs in the product journey; dedicated source suite remains canonical |
| Supervisor | integration | PASS | real summary from durable journey state |
| Fixed-domain MCP | real remote MCP E2E | BLOCKED | no remote authenticated E2E was executed from H |
| Tool catalog stale | host integration | NOT_IMPLEMENTED in H | C/F expose inventory/Doctor diagnostics; I compares schemas |
| Browser Use | real browser E2E | BLOCKED | 2026-09-20 Browser CUA kernel failed connecting its Windows runner pipe; no desktop fallback |
| Computer approval | real human/CUA E2E | BLOCKED | no approval was auto-answered; human approval boundary preserved |
| Runtime restart | isolated integration | PASS | V2 durable state reopened; not a real OS process crash/restart |
| Long-running process | isolated local E2E | PASS | real child returns running session then terminal exit receipt |
| Auto Rollover | real browser/product E2E | NOT_IMPLEMENTED | E remains preparatory and A14 still blocks unattended takeover |
| DB busy | chaos | NOT_RUN | not injected in H to avoid a 5-second SQLite global lock affecting unrelated validation |
| Child process exit | chaos | PASS | real non-zero exit code 7 preserved |
| Port conflict | chaos | PASS | real loopback `EADDRINUSE` |
| MCP timeout / network transient | remote chaos | BLOCKED | no safe remote endpoint owned by H |
| stale PID / stale lock / named pipe missing | runtime chaos | NOT_RUN | G/F owner branches; reviewed in I |
| browser disconnect | real browser chaos | BLOCKED | Browser Use runtime unavailable in this environment |
| workspace missing | chaos | FAIL (reproduced) | persisted checkout is restored from metadata although its directory is gone; see E2E-004 |
| worktree missing / partial Git external effect | crash-shaped integration | NOT_IMPLEMENTED on main | A branch contains recovery/quarantine tests; H does not duplicate production owner code |
| target branch moves | integration chaos | NOT_IMPLEMENTED on main | fixed/tested on A; see E2E-001 |
| invalid config | chaos | PASS | real parser rejects invalid port |

H modifies tests/docs only. Production core modifications: **0**.

## H branch validation

- `pnpm install --frozen-lockfile`: PASS
- `pnpm exec tsx --test --test-concurrency=1 tests/e2e/product-journeys.test.ts tests/chaos/host-chaos.test.ts`: PASS, 8/8, 0 skipped
- `pnpm typecheck`: PASS
- `git diff --check`: PASS
- real remote MCP / real Browser / human Computer approval: BLOCKED or NOT_RUN exactly as listed above

# DevSpace security adversarial matrix

Date: 2026-09-20. J branch base: `main` `5b0fefa`.

Tests use only temporary local projects/directories and synthetic credentials.
No real third-party account, MFA, mailbox, OAuth approval, production data or
destructive remote action is exercised. Production core modifications: **0**.

| Attack / trust boundary | Status on main | Evidence / owner |
| --- | --- | --- |
| Cross-project integration/handoff ID | PASS | scoped getters reject foreign project keys |
| Workspace handle reuse across project | PASS in current scoped APIs | existing workspace/project scoping; deeper stale-root case tracked by H E2E-004 |
| Lexical traversal / outside absolute path | PASS for root lexical checks | existing root checks |
| Junction/symlink mutation escape | **CONFIRMED** | SEC-002; owner A14 |
| Stale lease completion | PASS | old release/complete receipt rejected |
| Old worker incarnation | NOT_IMPLEMENTED on main | A10/A13 implements explicit worker/attempt fencing |
| Evidence forgery / false validation | **CONFIRMED** | SEC-001; owner A1/A2 |
| Handoff replay after authority change | **CONFIRMED** | SEC-003; owner A13 |
| Rollover replay | NOT_IMPLEMENTED | E has no production epoch/takeover controller yet |
| Wrong browser account/workspace | BLOCKED | no real account attack performed |
| Browser origin redirect / fail-closed bypass | BLOCKED | local Browser Use runtime unavailable; no desktop fallback |
| OAuth secret leakage | PASS for existing card/OAuth regressions; NOT re-probed against real OAuth | existing isolated auth suites use synthetic secrets |
| Runtime PID reuse / port hijack | NOT_RUN in J | G/F owner; H separately reproduced loopback port conflict |
| Release tamper | NOT_RUN in J | B owner branch; I validates release/merge compatibility |
| Tool catalog confusion | NOT_RUN in J | C/F/I owner surfaces |
| Supervisor XSS | PASS | existing `orchestration-supervisor.test.ts` escapes script payloads and forbids inline handlers |
| Command injection | shell authority is intentional; no structured-surface injection confirmed | unrestricted shell model is explicitly out of A14 scope |
| SQL scope / mutation | PASS | existing `sqlite-query.test.ts` read-only rejection regression |
| Resource exhaustion | PASS for bounded handoff payload | 8 KiB field / 64 KiB payload bounds; broader exhaustion remains A16/H/J follow-up |

Focused J regression source: `tests/security/orchestration-red-team.test.ts`.

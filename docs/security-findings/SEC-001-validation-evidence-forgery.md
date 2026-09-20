# SEC-001 — Validation evidence can be forged from heuristic tool telemetry

- Severity: high
- Base: `main` `5b0fefa`
- Owner: `pro/v2.1-reliability-hardening` A1/A2
- Status on main: CONFIRMED
- Status on owner branch: fixed by execution-observed TestRun/Evidence IDs

## Trust boundary

Integration readiness trusts a caller-supplied pair `(eventId, commit)` and a
generic `test_run` event whose `detail.passed` is true. Automatic telemetry on
main classifies a command by keyword and treats a non-error tool response as a
passing test without requiring process termination or a positive test receipt.

## Reproduction

The security regression feeds the observer an `exec_command` result representing
a still-running `node --test --help`. Main emits a passed `test_run`. After an
actual candidate commit is made, that event ID is attached to the candidate via
`integration_update`; the gate accepts the evidence and reaches `mergeReady`.

## Expected

Only a trusted execution lifecycle may issue evidence after the process has
terminated successfully, with immutable tested commit/tree, environment/check
definition and current attempt/worker authority. Integration should reference
the Evidence ID, not let a caller associate arbitrary event and commit facts.

## Impact

A non-validation or unfinished command can satisfy a merge-readiness security
gate. This undermines the evidence trust boundary rather than merely displaying
an inaccurate health badge.

## Recommended regression

Keep the J reproduction against main and the A tests for exit 1, running,
signal, timeout, `--help`, stale candidate and execution-issued Evidence IDs.

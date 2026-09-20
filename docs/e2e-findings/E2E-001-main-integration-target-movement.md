# E2E-001 — Main integration snapshot does not model a moving target

- Severity: high before integration of A
- Owner branch: `pro/v2.1-reliability-hardening`
- Base observed: `main` `5b0fefa`
- Status: fixed in owner branch, not fixed in main

## Reproduction

Create a candidate worktree, record passing evidence, then advance the source
target after the candidate/evidence snapshot and before integration gating.

## Expected

The gate captures candidate and target immutable OIDs, performs a real
side-effect-free merge simulation, and publishes only if target/generation are
still the captured values.

## Actual on main

The baseline integration record is based on the worktree binding/base SHA and
does not implement the later A7/A8 target-generation protocol. Therefore H does
not certify moving-target correctness on main.

## Current owner evidence

`pro/v2.1-reliability-hardening` contains the A7/A8 implementation and focused
target-move/merge conflict tests. H intentionally does not copy that production
fix into this branch.

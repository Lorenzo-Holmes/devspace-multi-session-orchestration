# E2E-004 — Missing persisted checkout is restored without existence verification

- Severity: medium
- Owner branch: reliability/workspace core (`pro/v2.1-reliability-hardening` follow-up)
- Base observed: `main` `5b0fefa`
- Status: CONFIRMED on main

## Reproduction

Persist a checkout workspace, remove the underlying directory, construct a new
`WorkspaceRegistry` over the same durable store, then request the persisted
workspace by id.

## Expected

Restoration should fail closed (or mark the session unavailable) before
returning a usable Workspace object.

## Actual

`getWorkspace()` reconstructs the object from stored metadata and lexical root
authorization even though the root no longer exists. The next real filesystem
operation fails with ENOENT, but the restoration itself appears successful.

## Impact

Supervisor/host code can temporarily treat a vanished checkout as restored,
delaying the fault until a later filesystem operation. H does not patch the
production owner; the regression reproduction remains in
`tests/chaos/host-chaos.test.ts`.

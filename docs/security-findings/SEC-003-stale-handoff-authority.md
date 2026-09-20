# SEC-003 — Handoff acknowledgement survives sender task-authority loss

- Severity: medium
- Base: `main` `5b0fefa`
- Owner: `pro/v2.1-reliability-hardening` A13
- Status on main: CONFIRMED
- Status on owner branch: fenced by worker/attempt/binding generation

## Trust boundary

Main validates task ownership only when a handoff is created. The durable
handoff does not capture the sender's execution attempt, worker incarnation or
binding generation, and acknowledgement does not revalidate them.

## Reproduction

Create a task handoff, release the sender's lease, reclaim the task under a
different session, then acknowledge the old handoff from its originally named
receiver. Main accepts the acknowledgement.

## Expected

A task-authoritative handoff should carry the execution attempt/generation that
authorized it. If that authority is superseded before acknowledgement, the old
handoff cannot become current authoritative state.

## Impact

Stale coordination metadata can be accepted after ownership transfer, creating
an inconsistent handoff history and a replay primitive for later automation.

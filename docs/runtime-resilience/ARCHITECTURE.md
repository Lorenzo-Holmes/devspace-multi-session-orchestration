# Runtime resilience architecture

Status: opt-in implementation under review; not a production deployment approval. See `TEST-MATRIX.md` for the distinction between isolated verification and full-project CI.

## Boundaries

The infrastructure supervisor may restart an explicitly approved server or managed tunnel. It cannot select a release, execute an orchestration task, transfer task ownership, change a conversation epoch, mutate a workspace, or approve a browser action. The existing read-only orchestration supervisor and the local agent daemon remain separate.

| Area | Implementation | Responsibility |
| --- | --- | --- |
| Contracts | `src/runtime-lifecycle/contracts.ts` | Runtime identities, states, observations, policy, bounded status |
| Journal | `src/runtime-journal/store.ts` | Transactional ownership, launch reservations, durable controls and recovery records |
| Planning | `src/runtime-recovery/planner.ts` | Pure bounded policy decisions; no execution authority |
| Supervisor | `src/runtime-supervisor/supervisor.ts` | Reconcile identity, health, stop intent and restart budget |
| Native adapter | `src/runtime-supervisor/native.ts`, `worker.ts` | Fixed bootstrap of the approved entrypoint and explicitly managed tunnel |
| Process backend | `src/process-supervision/process.ts` | Birth identity, owned listener verification and handle-based termination |
| Health | `src/service-health/mcp-probe.ts` | Read-only HTTP/MCP readiness and approved build/catalog comparison |
| Browser recovery | `src/runtime-recovery/reconnect.ts`, `src/codex-cua-bridge.ts` | Serialized, bounded rediscovery without mutation replay |

## Durable launch protocol

1. Acquire a runtime owner token/epoch inside `BEGIN IMMEDIATE`. A living or uninspectable previous owner is not displaced because its heartbeat is old.
2. Reconcile a recorded worker before reserving a launch. An exact surviving process is adopted and health-checked, not duplicated.
3. Reserve a generation and one launch ticket transactionally; charge the component and global rolling budgets.
4. The Node bootstrap claims that ticket and publishes its process-birth identity before importing the approved server entrypoint. A revoked or already claimed ticket cannot execute the service.
5. Full readiness, not spawn acknowledgement, completes a recovery attempt. Lost acknowledgements and failed final writes leave durable state for the next reconciliation.

Cloudflared is a native child rather than an imported entrypoint. A crash between its spawn and PID publication cannot be made equivalent to the Node protocol. The journal records that native launch was attempted; an unresolved publication gap blocks further launches instead of guessing that no child exists.

## Dependency and ownership order

Start/recover the server before checking the remote tunnel. Stop a managed tunnel before the server. An external tunnel is observed only. A live tunnel with an unreachable remote endpoint is degraded, not automatically killed. User task children and the externally owned Codex application are outside this process registry.

## Persistence

`runtime-recovery.sqlite` is a separate runtime-owned SQLite database, not an orchestration migration. WAL, synchronous FULL writes and atomic snapshot updates retain owner fencing, controls, launch tickets, bounded events and bounded attempts. All launchers for an installation must use the same canonical private state directory. Two independent directories do not coordinate.

## Integration limits

`bin/devspace-runtime.js` is an optional built-code entrypoint. Existing foreground startup, package scripts, CI, release pointers and deployment scripts are not replaced. The production PowerShell supervisor was absent from the audited snapshot. Do not run both ownership protocols concurrently. Bundle immutability, packaging of the helper files, credential provisioning and OS startup installation require an explicit deployment handoff.

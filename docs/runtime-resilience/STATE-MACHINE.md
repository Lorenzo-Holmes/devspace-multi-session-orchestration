# Runtime state machine

The state vocabulary is `starting`, `healthy`, `degraded`, `recovering`, `stopping`, `stopped`, `crashed`, `blocked`, and `paused_needs_attention`. Not every component passes through every state: a runtime launch reservation currently enters `starting`; browser reconnection uses a separate recovery status.

| Observation or control | Result | Authority boundary |
| --- | --- | --- |
| Approved, enabled launch with budget | `starting` | Reserve once, then let the worker claim the ticket |
| Verified process, owned port and complete MCP readiness | `healthy` | Complete the attempt only after build/version/catalog checks |
| Live process but incomplete or transient health | `degraded` | Observe first; do not equate network failure with process death |
| Recorded process absent or proven PID-reused | `crashed` | Clear stale identity; never terminate the replacement PID |
| Startup/health deadline expires | `stopping` | Durable cooperative stop, then one verified force attempt after grace |
| Stop finishes | `stopped` | Persistent stop/upgrade intent prevents automatic relaunch |
| Unknown identity, occupied unknown port, invalid config, authentication boundary | `blocked` | Requires resolution; no speculative repair |
| Rolling restart budget exhausted | `paused_needs_attention` | Record `CRASH_LOOP`; no further automatic launches |
| Manual pause | Aggregate `paused_needs_attention` | Existing components are not killed merely because recovery is paused |

## Controls

`pause` inhibits launches. `resume` returns control to run mode and first reconciles any existing runtime; it does not clear the rolling restart budget. `stop` persists intentional shutdown. `restart` requests a drain before a successor starts; enabled policy, approved build and budget still apply. `upgrade` means stop for an external release handoff, not choose or install a release.

The aggregate runtime is degraded when the server is healthy but a configured remote tunnel is not healthy. External components do not prevent a clean managed shutdown. A clean-shutdown marker is written only when every managed component is stopped.

## Fencing and crash points

An owner update checks token, epoch and process identity. Worker updates check the launch token and holder identity. A delayed health response must still match the current runtime ID, generation and process identity before it can publish success. Worker registration wins or loses atomically against ticket revocation.

A successor reconciles dirty state rather than resetting it. A claimed server may be adopted after the former supervisor exits. A pending unclaimed ticket expires under the startup deadline and is revoked; a late bootstrap then cannot execute. An uncertain native-child launch is deliberately blocked.

## Time and boundedness

Polling is completion-relative and single-flight. Policy time is nondecreasing across backward wall-clock changes. Large forward/backward discontinuities create a reconciliation grace interval and reset continuous-health observations. This is a heuristic, not a native Windows power-event subscription. No clock expiry alone authorizes stealing a live owner.

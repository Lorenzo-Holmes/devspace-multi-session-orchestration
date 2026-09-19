# Codex CUA and browser connection recovery

`src/codex-cua-bridge.ts` remains the public import path. The original implementation and exported types/helpers move to `src/codex-cua-transport.ts`; the facade serializes calls and adds bounded browser rediscovery. No MCP tool name or schema is added by this workstream.

## Preserved behavior

Existing sidecar discovery, Windows pipe-prefix checks, trusted launch/module-root checks, direct Windows action mappings and elicitation callbacks remain in the transport. The original direct helper lifecycle continues to create/close a helper around each direct operation. This change does not make DevSpace the process supervisor of Codex itself.

The browser transport retains partially established client/transport references so failed connection setup can be cleaned up. Browser close clears cached references before awaiting teardown and propagates teardown failure to the recovery fence. These browser guarantees must not be generalized to every direct native cleanup path: the original direct cleanup behavior is otherwise retained.

## Safe retry boundary

Read-only browser inventory/tab observations may retry once on a fresh transport for an explicitly typed disconnect, such as SDK connection-closed code -32000, EPIPE, ECONNRESET or an unavailable pipe. Arbitrary browser text and error-message substrings are not evidence of a transport failure. Unknown failures and SDK timeout code -32001 do not get an inferred retry.

Browser clicks, typing, navigation, reloads and other action-and-observe operations are never replayed after failure. An action may have executed before the response was lost. The caller must inspect current state and decide the next action explicitly.

The facade forwards the existing approval callback. Decline/cancel, security and authentication boundaries do not trigger rediscovery as a way around approval. No callback means cancellation, not automatic acceptance. No browser setting, extension, profile, MFA state or OAuth approval is changed.

## Bounds and teardown

Operations are serialized with a bounded queue. Reconnection has a rolling failure budget and backoff. A failed or unresolved old transport close prevents creating its replacement; a timeout is not proof of successful cleanup. The internal `runtimeRecoveryStatus()` reports connection status but is not a newly registered control tool.

## Evidence and limits

Generic reconnect regressions run in the isolated test harness. Five additional facade/transport integration regressions cover fresh transport retry, action non-replay, security boundaries, failed teardown and declined elicitation. Those five require the repository's SDK/zod dependencies and were not executed in the dependency-free local harness. No real Codex update, Windows native pipe replacement, browser extension recovery or interactive approval session was exercised on the production host. See `TEST-MATRIX.md` for CI status.

# E2E-003 — Real Browser Use acceptance blocked by local CUA runtime

- Severity: medium for local acceptance; high for Auto Rollover E2E
- Owner: runtime/host environment, cross-check with G/F
- Status: BLOCKED

On 2026-09-20 an authorized read-only `browser_state` attempt failed before tab
enumeration because the local unified-computer-use kernel exited while waiting
for the Windows runner pipe. No browser tab was manipulated and no Computer Use
or desktop-control fallback was used.

Expected: trusted Browser Use returns browserId/tabId/providerTabId/current URL
and permits an exact-tab observation subject to its own approval/origin rules.

Actual: the Browser Use backend did not reach a usable session. Re-run after the
official CUA runtime is healthy; do not downgrade this result to SKIP/PASS.

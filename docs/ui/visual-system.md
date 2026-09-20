# DevSpace UI visual system

Status: implementation checkpoint for `pro/ui-visual-interaction-polish`.

## Inventory

The host-facing UI has two delivery surfaces. The React workspace app renders
workspace, aggregate review and workspace approval cards. Four self-contained
Ext Apps are packaged for Goal decisions, card diagnostics, Computer Use
approval and the read-only Supervisor. Loading, empty, error, blocked and
completed states are rendered by those existing state machines; this branch
changes presentation only.

## Visual language

The target is a restrained desktop engineering tool: neutral surfaces, one calm
blue accent, semantic success/warning/danger states, compact typography and
small-radius controls. It intentionally avoids neon, animated gradients,
overshoot and decorative glass effects.

`scripts/card-system.css` is the shared token and component layer for packaged
standalone cards. It defines surface/text/border/semantic colors, spacing by
component padding/gap, radii, shadow, typography and 140–190 ms motion. System
light/dark preference is supported without JavaScript or external resources.
`src/ui/workspace-app.css` exposes matching radius/motion/state aliases while
continuing to honor ChatGPT host color variables.

## Shared card anatomy

Standalone cards use Header → Summary/Context → Content → Status → Details →
Actions. Goal and diagnostic actions are still created by their original
controllers. Computer Use approval presents application, requested operation,
scope, duration and risk before its Allow/Deny actions. No state-machine,
permission, OAuth, timeout or tool semantics are changed.

## Interaction and accessibility

Controls use visible keyboard focus, minimum 40 px action height, live status
regions and responsive layouts. Narrow layouts are defined at 480/340 px for
standalone cards and 520/360 px for the workspace app, covering the requested
320–1280+ range through fluid max-width layouts. `prefers-reduced-motion`
reduces all transition/animation durations. Status meaning is never conveyed by
color alone; text remains authoritative.

## Verification scope

`src/card-visual-contract.test.ts` locks shared tokens, accessibility hooks,
responsive/reduced-motion rules, approval information hierarchy and build-time
stylesheet injection. `pnpm build:chat-card` verifies that all four cards remain
self-contained under their existing CSP.

On 2026-09-20 the external Playwright CLI skill was available and was exercised
against the packaged diagnostic card through a loopback-only static server. The
real browser loaded `chat-card-probe.html`, produced an accessibility snapshot,
and captured viewport screenshots at 1280×900 light, 1280×900 dark and 360×800
dark. The snapshot exposed the expected heading, read-only badge, fail-closed
status region, disabled actions and diagnostic details. The three screenshot
commands completed successfully. These are runtime QA artifacts, not committed
golden images, so this is a focused visual smoke check rather than pixel-diff
regression coverage for every state.

An additional attempt to inspect the same browser via DevSpace Browser Use was
BLOCKED by the local CUA runtime (`windows sandbox ... timed out connecting
runner pipe-in`). It is not counted as a pass and no desktop-control fallback was
used. Remaining visual coverage gaps are populated Goal/Approval/Supervisor
states, explicit loading state and deterministic cross-platform screenshot
baselines.

Validation for branch head `a33f54a`:

- `pnpm install --frozen-lockfile`: PASS
- `pnpm typecheck`: PASS
- `src/card-visual-contract.test.ts`: PASS, 3/3, 0 skipped
- `pnpm build:chat-card`: PASS
- `pnpm build`: PASS (existing large-chunk warning only)
- Playwright diagnostic light/dark/narrow smoke: PASS
- DevSpace Browser Use screenshot parity: BLOCKED by local CUA runtime

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
self-contained under their existing CSP. The repository contains no Playwright
fixture or dependency, and the advertised external Playwright skill could not be
read through the current DevSpace allowed-root boundary, so screenshot-based
visual regression is recorded as not run rather than claimed as passing.

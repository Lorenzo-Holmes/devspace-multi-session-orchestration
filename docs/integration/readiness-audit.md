# DevSpace final multi-PR integration readiness audit

Audit date: 2026-09-20. Source of truth: current GitHub remote after `git fetch
--prune` plus open-PR metadata returned by GitHub CLI. This report does not
promote local-only work to implemented status and does not treat SKIP as PASS.

## Executive result

**NO ACTIVE PR IS READY FOR INTEGRATION.** `main@5b0fefa68e0f544f7dd30e4d63f4f9247ed80`
is still red in its latest recorded GitHub CI baseline (`35433596116`), but A now
demonstrates that the baseline is repairable without disabling assertions: PR #5
at `9543127df1cded08b098aa104de8baadfda8c428` is green on ubuntu, macOS and
Windows for install, typecheck, test, build and Doctor. A is nevertheless not
merge-ready because its documented A14 handle-level directory-replacement race
and A3 recovery follow-up remain product correctness gates. Other PRs must still
be rebased/rerun against the repaired reliability base; an old red check is not a
waiver and A's green checks do not automatically validate sibling branches.

A also remains product-blocked by its explicitly documented handle-level
directory-replacement containment gap. E therefore remains preparatory and must
not activate unattended ChatGPT takeover.

## I1 — current branch / PR inventory

| Area | Branch | PR / base | Head | Commits vs main | Files / delta | Classification |
| --- | --- | --- | --- | ---: | --- | --- |
| A Reliability | `pro/v2.1-reliability-hardening` | #5 Draft → `main` | `9543127df1cd` | 15 | 53; +3599/-458 | **PARTIAL / BLOCKED** |
| B Scale/Release | `pro/scale-release-hardening` | #3 Draft → `main` | `72074accb609` | 7 | 21; +1365/-7 | IMPLEMENTED_PARTIALLY_VERIFIED |
| C Control Plane | `pro/control-plane-observability` | #1 Draft → `main` | `6656b66d2a31` | 4 | 18; +1011/-16 | IMPLEMENTED_PARTIALLY_VERIFIED |
| D UI | `pro/ui-visual-interaction-polish` | #6 Draft → `main` | `a2c3fdccd34e` | 2 | 12; +224/-23 | IMPLEMENTED_PARTIALLY_VERIFIED |
| E Auto Rollover | `pro/auto-session-rollover` | #2 Draft → A | `1b1599191b98` | 4 | 19; +1172/-0 | **PREPARATORY / BLOCKED** |
| F Doctor | `pro/runtime-doctor-host-compatibility` | #7 Draft → `main` | `67e4644c876a` | 1 | 4; +687/-28 | IMPLEMENTED_PARTIALLY_VERIFIED |
| G Runtime Resilience | `pro/runtime-resilience` | #4 Draft → `main` | `8221f84b7128` | 5 | 39; +3292/-827 | IMPLEMENTED_PARTIALLY_VERIFIED |
| H E2E/Chaos | `pro/e2e-product-journeys` | #10 Draft → `main` | `08a487d4d47f` | 1 | 7; +290/-0 | IMPLEMENTED_PARTIALLY_VERIFIED |
| I Integration | `pro/integration-readiness` | #9 Draft → `main` | `f1385d2943ef` | 2 | 2; +363/-0 before this refresh | IMPLEMENTED_PARTIALLY_VERIFIED |
| J Security | `pro/security-adversarial-audit` | #8 Draft → `main` | `27bfb14e2529` | 1 | 5; +244/-0 | IMPLEMENTED_PARTIALLY_VERIFIED |

H now has Draft PR #10. PR creation succeeded without changing or merging any
branch. All ten active PRs remain Draft.

`codex/github-write-test@470b278` is a write-permission probe and is superseded
for product purposes. `codex/v2.1-hardening@5b0fefa` is identical to main and is
superseded by A. Neither branch was deleted; deletion is only a cleanup plan.

## I2 — changed-file intersection

Static intersections across A/B/C/D/E/F/G/H/J contain only two non-empty pairs:

1. **A ↔ E:** `.github/workflows/ci.yml` and
   `.github/workflows/hardening-workspace.yml`. This is expected stacked-history
   overlap. A/E currently merge textually clean.
2. **C ↔ D:** `scripts/supervisor/card.html`. This is a real content conflict in
   both merge directions. C owns Supervisor information/control-plane semantics;
   D owns visual hierarchy/tokens/motion/accessibility. Resolve manually after C
   is rebased/merged; do not choose one side wholesale.

No other changed-file intersection was found among the active branch heads.

## I3 / I6 — semantic ownership and duplicate abstractions

| Concern | Canonical owner | Integration rule |
| --- | --- | --- |
| Orchestration session / LogicalSession / worker / attempt identity | A | E, H and J consume A's identity/generation model; do not create a second session identity stack. |
| Execution TestRun / Evidence | A | Integration accepts execution-issued Evidence IDs. H/J main-era `eventId + commit` tests must be adapted. |
| Managed worktree operation/recovery | A | E checkpoint/takeover must reference A's immutable base OID and operation/attempt identity. |
| Browser / Codex CUA transport | G | F diagnoses it; E launcher consumes it. F/E must not add an alternate desktop fallback. |
| Runtime lifecycle / recovery state | G | F is read-only diagnosis; C is presentation/capability metadata, not a second runtime state machine. |
| Shell/process session manager | existing core + A hardening | G's process supervision is service-runtime supervision, not a replacement for `exec_command` process sessions. Keep scopes distinct. |
| Tool capability catalog / role selection | C | Recompute against A's changed schemas and G runtime availability after rebase. |
| Supervisor data semantics | C | D may restyle the card only after preserving C presenter/data hooks. |
| Release / rollback / reproducibility | B | Re-run after production branches settle; no second release contract in I. |
| Auto conversation epoch / takeover | E (future) | Must be layered on A identity/fencing and G Browser transport; currently not implemented. |
| Security findings / acceptance matrices | H/J | Tests/docs must follow the final product contracts; they do not own production fixes. |

No duplicate production Browser adapter or generic process manager is required by
the present branches. The important risk is semantic drift, not same-file
duplication.

## I4 — migration matrix

`main` defines migrations through version 18. Only A changes
`src/db/migrations.ts`; B/C/D/E/F/G/H/J do not modify that file relative to main.
A appends, without rewriting old migrations:

- 19 `session-cas-and-mutation-generation`
- 20 `workspace-approval-reservations-and-config-journal`
- 21 `trusted-validation-evidence`
- 22 `logical-session-and-execution-attempt-fencing`

Result: **no duplicate migration number or same-number/different-content conflict
is present across the current remote branches**. E is thirteen A-only commits behind
latest A and two E-only commits ahead of the A/E merge base; after
rebase it must inherit 19–22 rather than duplicate them.

## I5 — tool/schema compatibility

A materially changes existing orchestration/process contracts: Integration moves
from caller-declared `testEvidence(eventId, commit)` to execution-issued
`evidenceIds`, adds immutable candidate/target generation checks, and the process
surface gains stronger terminal/timeout/process identity facts. C owns the tool
capability catalog and therefore must refresh catalog/schema expectations after
A. G changes CUA runtime implementation but should continue to use the existing
host-facing Browser/Computer tool registrations.

No changed-file evidence indicates two branches independently registering a new
same-name MCP tool. The current blocker is **same-name schema evolution in A plus
downstream stale consumers**, especially H/J tests and C catalog expectations.
After rebases, compare live `tools/list` names, visibility and schema fingerprint;
do not rely only on static source matching.

## I7 — validation truth

GitHub CI truth at this refreshed audit point:

- `main` latest push: install PASS, typecheck PASS, tests FAIL on all three OS
  lanes, build/doctor SKIPPED.
- PR #5 / A at exact head `9543127`: **PASS on ubuntu-latest, macos-latest and
  windows-latest**. Every lane passed install, typecheck, test, build and Doctor;
  the platform-specific Pi sandbox install remains SKIP where the workflow does
  not support it. This is the first current branch with a complete green
  cross-platform Smoke receipt in this audit.
- The other PRs retain older red Smoke receipts until they are rebased/rerun.
  Those failures overlap the red main baseline and are not reclassified as PASS.

Independent local Windows validation performed during this build:

| Branch | Focused/full tests | Typecheck | Build / UI | Important limits |
| --- | --- | --- | --- | --- |
| A | exact head `9543127` local full **370 total / 357 pass / 0 fail / 13 skip**; GitHub Smoke test PASS on Linux/macOS/Windows | PASS locally and all three GitHub lanes | PASS on all three GitHub lanes; Doctor PASS | A14 handle-level replacement race remains unproven; A3 runtime recovery remains follow-up; SKIP stays SKIP |
| B | release/benchmark focused suite **91 total / 90 pass / 0 fail / 1 environment skip**; release-engineering wrapper PASS | PASS | release pipeline focused checks PASS; full branch build not rerun in this continuation | `pwsh.exe` absence is an environment SKIP, not PASS; re-run after final production rebase |
| C | control-plane/catalog/Supervisor focused suite **161/161 PASS**, 0 skip | PASS | full branch build not rerun in this continuation | catalog expectations still need regeneration against A's changed schemas |
| D | visual contract **3/3 PASS**, 0 skip in this continuation; branch docs also record real visual smoke evidence | PASS | `build:chat-card` PASS; full build PASS | current host also exposes an unsupported Node 22.17 installation, so exact release validation must pin a supported Node runtime |
| E | NOT_RUN after latest A | not certified against latest A | NOT_RUN | preparatory only; 13 A commits behind and 2 E-only commits ahead |
| F | Doctor **4/4 PASS**, 0 skip under verified Node 24.19.0 | PASS under Node 24.19.0 | full build PASS under a PATH with Node 24.19.0 first | host Browser attachment correctly remains UNKNOWN; no approval/OAuth action was taken |
| G | runtime supervisor/recovery/CUA focused suite **98/98 PASS**, 0 skip | PASS | full branch build not rerun in this continuation | must rebase on A before its runtime/CUA evidence is integration-authoritative |
| H | product/chaos suite **8/8 PASS**, 0 skip under verified Node 24.19.0 | PASS | build NOT_RUN (tests/docs branch) | real Browser/remote MCP/human approval remain BLOCKED/NOT_IMPLEMENTED; tests are explicitly labelled isolated where applicable |
| J | adversarial orchestration suite **5/5 PASS**, 0 skip under verified Node 24.19.0 | PASS | build NOT_RUN (tests/docs branch) | 3 PASS cases deliberately reproduce main vulnerabilities; A contains candidate fixes for all three |

Local validation does not override red GitHub checks. A is the exception only
because its exact remote head now also has complete green hosted CI evidence.

The I documentation branch itself was validated on Windows with the verified
Node 24.19.0 toolchain: install PASS; full `pnpm test` PASS with **306 total / 293
pass / 0 fail / 13 skip**; typecheck PASS; build PASS; `git diff --check` PASS.
Those 13 skips remain SKIP and do not repair the red GitHub-hosted baseline.

## I8 — merge simulation

Pure Git three-way simulation used `git merge-tree --write-tree`; no merge commit
was pushed and no branch ref was advanced.

The exact-head sequence **A (`9543127`) → G → F → B → C → H → J** was textually
clean at every step using synthetic commits created only in the local Git object
database; no ref was advanced and no merge commit was pushed. The final synthetic
sequence commit was `f9ee2f4ada8b34f2f24f417514c3853088898ce4`. Adding D after C/J
produced a deterministic content conflict in `scripts/supervisor/card.html`.
A + E also produced a clean merge tree (`5397849d298ddfdc6303e496b8e8a162f3a45f7c`).

A requested temporary combined worktree for actual post-merge build/test was
blocked by the platform safety layer and was not recreated through another route.
Therefore build/test-level combined status is **BLOCKED / NOT_RUN**, not PASS.

Source-contract review already identifies semantic conflicts that a clean tree
does not catch:

- H's integration journey still calls main's `testEvidence(eventId, commit)` API.
  It must be rewritten to obtain A execution-issued Evidence IDs.
- J SEC-001 uses the same obsolete evidence API; after A the test should assert
  rejection/no evidence, not successful exploit reproduction.
- J SEC-002/SEC-003 intentionally assert main vulnerabilities succeed. After A,
  those tests must invert into fixed-security regressions while retaining the
  historical findings documents.
- C's capability/catalog expectations must be regenerated against A's process
  and integration tool schemas.

## I9 — recommended merge order

There is no safe immediate merge order while A14/A3 remain open, even though A's
hosted CI is now green. Once those product gates are cleared, use this
dependency-oriented order:

1. **A Reliability** — keep the now-green cross-platform CI; complete A14/A3
   runtime-recovery follow-up; land identity/evidence/attempt/migrations first.
2. **G Runtime Resilience** — rebase on A; keep G as Browser/CUA/runtime-recovery
   owner.
3. **F Doctor** — rebase on A+G so diagnostics describe the canonical runtime.
4. **C Control Plane** — rebase on A+G; refresh tool schemas/catalog/freshness.
5. **D UI** — rebase after C and manually resolve Supervisor card with C semantics
   + D presentation.
6. **B Scale/Release** — rebase onto the assembled production surface and rerun
   release/reproducibility/rollback validation against what will actually ship.
7. **E Auto Rollover** — **HOLD, do not merge in current form.** Complete it only
   after A and G are stable and real Browser E2E is available.
8. **H E2E/Chaos** — rebase onto final production core, adapt A APIs, run real
   environment lanes where available, then merge acceptance regressions.
9. **J Security** — rebase onto final core, turn confirmed-main exploits into
   rejection regressions, rerun red team, then merge.
10. **I Integration** — refresh this audit/checklist with final SHAs and green
    evidence last.

## Required rebases / retargets

- A: rebase only if main changes before its gate clears.
- G: rebase onto A after A is mergeable.
- F: rebase onto merged/rebased A+G.
- C: rebase onto the reliability/runtime base and refresh catalog expectations.
- D: rebase after C; resolve `scripts/supervisor/card.html` manually.
- B: rebase after production owners stabilize, then rerun release contracts.
- E: PR #2 is already correctly based on A, but the branch is 13 A commits behind;
  rebase onto latest A. **After A merges, retarget #2 from A to `main`.** Later
  incorporate G before production Browser launcher work.
- H/J: rebase onto the final production core and adapt tests before merge.
- I: rerun from fresh remotes after all preceding rebases.

No other PR base retarget is currently required.

## Current high-risk blockers

1. Main CI baseline is red, although A now proves a green three-OS repair path.
2. A14 cannot yet prove concurrent directory-replacement containment at the
   handle level; unattended takeover remains unsafe.
3. E has no durable production ConversationEpoch/RolloverAttempt/atomic takeover
   controller and no real Browser E2E.
4. C/D have a guaranteed Supervisor-card conflict.
5. H/J are semantically stale after A despite textually clean Git merges.
6. Real Browser Use acceptance is blocked in this environment by the local CUA
   Windows runner-pipe failure; no desktop fallback was used.
7. B/C/G have substantive remote implementations and their focused local suites
   passed in this continuation (B 90 PASS + 1 environment SKIP; C 161 PASS; G 98
   PASS), but their hosted Smoke lanes still require exact-head reruns after the
   required rebases.


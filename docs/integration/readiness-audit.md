# DevSpace final multi-PR integration readiness audit

Audit date: 2026-09-20. Source of truth: current GitHub remote after `git fetch
--prune` plus open-PR metadata returned by GitHub CLI. This report does not
promote local-only work to implemented status and does not treat SKIP as PASS.

## Executive result

**NO ACTIVE PR IS READY FOR INTEGRATION.** The dominant global gate is that
`main@5b0fefa68e0f544f7dd30e4d63f4f9247ed80` is already red in GitHub CI on
ubuntu, macOS and Windows. In the latest main push run (`35433596116`) dependency
installation and typecheck passed on every lane, the Test step failed on every
lane, and Build/Doctor were skipped. Current PR red checks therefore overlap a
known baseline failure, but each PR still must be rerun green after the baseline
is repaired; baseline failure is not a waiver.

A also remains product-blocked by its explicitly documented handle-level
directory-replacement containment gap. E therefore remains preparatory and must
not activate unattended ChatGPT takeover.

## I1 — current branch / PR inventory

| Area | Branch | PR / base | Head | Commits vs main | Files / delta | Classification |
| --- | --- | --- | --- | ---: | --- | --- |
| A Reliability | `pro/v2.1-reliability-hardening` | #5 Draft → `main` | `a7cd28786077` | 11 | 47; +3524/-435 | **PARTIAL / BLOCKED** |
| B Scale/Release | `pro/scale-release-hardening` | #3 Draft → `main` | `72074accb609` | 7 | 21; +1365/-7 | IMPLEMENTED_PARTIALLY_VERIFIED |
| C Control Plane | `pro/control-plane-observability` | #1 Draft → `main` | `6656b66d2a31` | 4 | 18; +1011/-16 | IMPLEMENTED_PARTIALLY_VERIFIED |
| D UI | `pro/ui-visual-interaction-polish` | #6 Draft → `main` | `a2c3fdccd34e` | 2 | 12; +224/-23 | IMPLEMENTED_PARTIALLY_VERIFIED |
| E Auto Rollover | `pro/auto-session-rollover` | #2 Draft → A | `1b1599191b98` | 4 | 19; +1172/-0 | **PREPARATORY / BLOCKED** |
| F Doctor | `pro/runtime-doctor-host-compatibility` | #7 Draft → `main` | `67e4644c876a` | 1 | 4; +687/-28 | IMPLEMENTED_PARTIALLY_VERIFIED |
| G Runtime Resilience | `pro/runtime-resilience` | #4 Draft → `main` | `8221f84b7128` | 5 | 39; +3292/-827 | IMPLEMENTED_PARTIALLY_VERIFIED |
| H E2E/Chaos | `pro/e2e-product-journeys` | #10 Draft → `main` | `08a487d4d47f` | 1 | 7; +290/-0 | IMPLEMENTED_PARTIALLY_VERIFIED |
| I Integration | `pro/integration-readiness` | #9 Draft → `main` | `14dbce297eaa` | 1 | 2; +364/-0 before this refresh | IMPLEMENTED_PARTIALLY_VERIFIED |
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
is present across the current remote branches**. E is nine A-only commits behind
latest A and two E-only commits ahead of the A/E merge base (`0cf912f`); after
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
- PRs #1–#10: every currently reported Smoke lane is FAILURE on ubuntu-latest,
  macos-latest and windows-latest. This includes the newly created H PR #10.
  These red checks cannot be waived merely because `main` is already red.

Independent local Windows validation performed during this build:

| Branch | Focused/full tests | Typecheck | Build / UI | Important limits |
| --- | --- | --- | --- | --- |
| A | branch ledger at `a7cd287` records full **369 total / 356 pass / 0 fail / 13 skip** after A10–A14; a duplicate focused run in this continuation lost its final process receipt and is therefore UNKNOWN, not an additional PASS | branch ledger records PASS | branch ledger records PASS; SKIP stays SKIP | A14 handle-level replacement race remains unproven; A3 runtime recovery remains follow-up |
| B | NOT_RUN in this final session | GitHub step reaches tests | GitHub build skipped | remote CI red |
| C | NOT_RUN in this final session | GitHub step reaches tests | GitHub build skipped | remote CI red; must refresh A schemas |
| D | visual contract **3/3 PASS**, 0 skip in this continuation; branch docs also record real visual smoke evidence | PASS | `build:chat-card` PASS; full build PASS | current host also exposes an unsupported Node 22.17 installation, so exact release validation must pin a supported Node runtime |
| E | NOT_RUN after latest A | not certified against latest A | NOT_RUN | preparatory only; 9 A commits behind |
| F | Doctor **4/4 PASS**, 0 skip under verified Node 24.19.0 | PASS under Node 24.19.0 | full build PASS under a PATH with Node 24.19.0 first | host Browser attachment correctly remains UNKNOWN; no approval/OAuth action was taken |
| G | NOT_RUN in this final session | GitHub step reaches tests | GitHub build skipped | remote CI red |
| H | product/chaos suite **8/8 PASS**, 0 skip under verified Node 24.19.0 | PASS | build NOT_RUN (tests/docs branch) | real Browser/remote MCP/human approval remain BLOCKED/NOT_IMPLEMENTED; tests are explicitly labelled isolated where applicable |
| J | adversarial orchestration suite **5/5 PASS**, 0 skip under verified Node 24.19.0 | PASS | build NOT_RUN (tests/docs branch) | 3 PASS cases deliberately reproduce main vulnerabilities; A contains candidate fixes for all three |

Local validation does not override red GitHub checks.

The I documentation branch itself was validated on Windows with the verified
Node 24.19.0 toolchain: install PASS; full `pnpm test` PASS with **306 total / 293
pass / 0 fail / 13 skip**; typecheck PASS; build PASS; `git diff --check` PASS.
Those 13 skips remain SKIP and do not repair the red GitHub-hosted baseline.

## I8 — merge simulation

Pure Git three-way simulation used `git merge-tree --write-tree`; no merge commit
was pushed and no branch ref was advanced.

The refreshed sequence **A → G → F → B → C → H → J** was textually clean at
every step using synthetic commits created only in the local Git object database;
no ref was advanced and no merge commit was pushed. Adding D after C produced a deterministic content conflict in
`scripts/supervisor/card.html`; reversing D/C produced the same conflict. A + E
also produced a clean merge tree.

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

There is no safe immediate merge order while A14 and baseline CI are red. Once
those gates are cleared, use this dependency-oriented order:

1. **A Reliability** — complete A14/A3 runtime-recovery follow-up; restore green
   CI; land identity/evidence/attempt/migrations first.
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
- E: PR #2 is already correctly based on A, but the branch is 9 A commits behind;
  rebase onto latest A. **After A merges, retarget #2 from A to `main`.** Later
  incorporate G before production Browser launcher work.
- H/J: rebase onto the final production core and adapt tests before merge.
- I: rerun from fresh remotes after all preceding rebases.

No other PR base retarget is currently required.

## Current high-risk blockers

1. Main CI baseline is red on ubuntu/macOS/Windows; tests fail before build.
2. A14 cannot yet prove concurrent directory-replacement containment at the
   handle level; unattended takeover remains unsafe.
3. E has no durable production ConversationEpoch/RolloverAttempt/atomic takeover
   controller and no real Browser E2E.
4. C/D have a guaranteed Supervisor-card conflict.
5. H/J are semantically stale after A despite textually clean Git merges.
6. Real Browser Use acceptance is blocked in this environment by the local CUA
   Windows runner-pipe failure; no desktop fallback was used.
7. B/C/G have substantive remote implementations but were not re-executed in
   this continuation; their current GitHub Smoke lanes remain red and require
   exact-head reruns after rebases.


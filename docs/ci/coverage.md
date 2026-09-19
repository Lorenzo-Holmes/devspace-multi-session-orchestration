# CI coverage and recorded verification

Status: partial implementation; not release-ready. This document separates
workflow configuration, local standalone contracts and actual remote results.
Historical numbers in REVIEW_BRIEF.md belong to another source workspace and
are not substituted for this branch's results.

## Unchanged workflow and added test discovery

`.github/workflows/ci.yml` at base
`5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80` runs on main pushes and pull
requests. It has Ubuntu/macOS/Windows jobs with Node 22 and a 15-minute timeout:
checkout; pinned pnpm setup; frozen dependency install; Linux sandbox
prerequisites; typecheck; all source tests; build; doctor. Later steps are
skipped after a failure. No new workflow was written.

An attempted workflow update was blocked by the tool safety check, not by a
reported GitHub HTTP permission error. Ordinary source/script/document writes
succeeded. No alternate write route was used for the blocked workflow.

`src/release-engineering.test.ts` makes the new engineering contract suites
discoverable by the existing source-test command. It removes inherited
NODE_TEST_CONTEXT from the child, requests TAP, verifies that child tests
actually ran, and emits their totals and skip reasons. Benchmarks are not
silently run inside unit tests. Test files remain excluded from production
TypeScript output by the existing tsconfig.build.json.

## Local final standalone contracts

```text
node --test scripts/release-contract.test.mjs scripts/release-pipeline.test.mjs benchmarks/orchestration/fixtures.test.mjs
```

Recorded on Linux x64 with Node v22.16.0: **91 total / 89 pass / 0 fail /
2 PLATFORM_SKIP**. These are 74 integrity/rollback/fingerprint cases, eight
generator cases and nine pipeline cases. The two skips require real Windows
PowerShell 5.1 and PowerShell 7. No Windows execution is inferred from static
source checks. The source wrapper was separately run with Node's experimental
TypeScript stripping and passed; it contains the same child suite, not 91
additional application tests. This is not the repository-wide pnpm suite.

The local runtime is below the package minimum >=22.19, pnpm is absent and a
clone attempt failed DNS resolution for github.com. Local application install,
full-source tests, TypeScript checking and canonical build were unavailable.
The build wrapper returned ENVIRONMENT_SKIP; the real CoordinatorStore smoke
also returned ENVIRONMENT_SKIP because dist was absent. These are not passes.

## Actual remote run, pinned to the tested revision

Run: https://github.com/Lorenzo-Holmes/devspace-multi-session-orchestration/actions/runs/35444001138
Head: `ca9e415349c33dcf39c8f0c083128c3489938061` (earlier than this document).
Observed September 19, 2026; this is not a claim about a later head.

Dependency installation and typecheck succeeded in all three matrix jobs.
Ubuntu job 105899694349 used Node 22.23.2 and pnpm 11.25.0 and completed the
source suite with **307 total / 294 pass / 2 fail / 11 skip**. The new engineering
wrapper passed. Failures were the unchanged server.test.ts CUA tool exposure
and browser_state scope assertions; see [follow-ups](../scale-release-followups.md).
Ubuntu build and doctor were skipped. Windows testing was cancelled and
macOS testing was still in progress at the recorded job snapshot. Do not
interpret those snapshots as successful completed platform runs.

The hosted runner's action bootstrap runtime is distinct from pnpm's selected
application runtime; the observed application was Node 22.23.2, not Node 24.

## Coverage still requiring execution or integration

| Area | Current evidence | Missing evidence |
| --- | --- | --- |
| Release integrity / offline rollback | Real temporary-file fault tests | Actual candidate/rollback artifact verification |
| Canonical build / stale output | Wrapper and static delegation contracts | Completed application build and native runtime |
| PowerShell | Explicit Utility import; parser/hash harness | Real no-profile 5.1/7 release acceptance |
| Definition fingerprint | Same-name schema/annotation/visibility regressions; probe wiring | Trusted complete catalog capture from exact candidate |
| Packaged V2 HTTP acceptance | Existing authenticated test located; observed CI skip | Isolated portable fixture and successful packaged run |
| Scalability | Deterministic generators; real store adapter | Executed smoke/full measurements and remaining subsystem adapters |
| Whitespace and script syntax | Local changed-file checks only | Workflow-level checks against complete checkout |
| Evidence | Sanitized repository JSON and documentation | Always-upload CI artifacts tied to final commit |

Use PASS only for executed successful assertions, FAIL for executed failures,
PLATFORM_SKIP for inapplicable platforms, and ENVIRONMENT_SKIP for missing
required execution conditions. Cancellation, pending results and unimplemented
coverage are separate states. No skip or descriptor generation is a release
acceptance pass. Raw tokens, configurations, production databases and fixture
state must never be uploaded as public evidence.

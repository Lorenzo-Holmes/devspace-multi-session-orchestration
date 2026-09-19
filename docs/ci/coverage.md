# CI verification coverage

## Audited source

This inventory describes `.github/workflows/ci.yml` and `package.json` at
`5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`. It is a configuration audit, not
evidence that any job or test passed. The verification numbers in
`REVIEW_BRIEF.md` describe a separate source workspace and must not be treated
as results for this branch.

## Existing workflow

The workflow runs on pushes to `main` and on pull requests. Its smoke matrix
includes `ubuntu-latest`, `macos-latest`, and `windows-latest`, with Node 22
selected by the pinned pnpm setup action. Each job has a 15-minute timeout.

The configured sequence is:

1. Checkout and set up pnpm/Node.
2. `pnpm install --frozen-lockfile`.
3. On Linux, install the sandbox prerequisites.
4. `pnpm typecheck`.
5. `pnpm test` with the Linux sandbox requirement enabled on Linux only.
6. `pnpm build`.
7. `node dist/cli.js doctor`.

`pnpm test` invokes `tsx --test --test-concurrency=1 "src/**/*.test.ts"`.
`pnpm build` invokes clean, the Vite app build, the chat-card build, and the
TypeScript build in that order. The configured suite is broader than a
single smoke test, but test-level platform coverage needs actual runner
results; matrix membership alone does not prove Windows-specific behavior.

## Coverage gaps in the audited workflow

| Area | Configured coverage | Evidence still needed |
| --- | --- | --- |
| Dependency installation | Frozen lockfile on all three platforms | Per-run installation outcome and runtime identity |
| TypeScript | Repository typecheck command | Exit status for the tested commit |
| Unit/integration tests | Complete existing source test command | Totals and explicit skip classification |
| Production build | Existing package build command | Exit status and artifact validation |
| Whitespace | No explicit check | `git diff --check` for the proposed changes |
| Release-script static checks | Not separately configured | JavaScript syntax and PowerShell parser checks |
| Packaged acceptance | Not separately configured | Tests against assembled dist and isolated state |
| Release/rollback integrity | Not separately configured | Positive and fault-injection fixture results |
| Scalability benchmarks | Not configured | Smoke metrics plus a separate full-scale run |
| Windows PowerShell | No explicit acceptance step | Windows PowerShell 5.1 and PowerShell 7 without profiles |
| Evidence artifacts | No upload step | Sanitized summaries, not production state or secrets |

## Result vocabulary

Use `PASS` only for an executed check whose assertions passed. Use `FAIL` for
an executed check that failed. Use `PLATFORM_SKIP` when a test is deliberately
inapplicable to the current platform, and include its reason. Use
`ENVIRONMENT_SKIP` when a required runtime, dependency, permission, or runner
is unavailable. A skip is not a pass. Do not infer test counts from historical
release notes or from the workflow definition.

## Current execution limitation

The engineering environment inspected for this change has Node 22.16.0 and no
`pnpm` executable. Node 22.16.0 is below the package's declared minimum of
22.19. A local clone attempt failed because `github.com` could not be resolved.
Consequently installation, the existing test suite, typecheck, and production
build have not run in this environment.

An attempted update to `.github/workflows/ci.yml` was blocked by the tool
safety check. No GitHub HTTP permission error was returned, so this does not
establish that the repository itself denied workflow permissions. Remote
comparison immediately afterward confirmed this branch still matched the
base commit. No alternate write route was used for the blocked workflow.

This document does not change CI behavior, claim new platform coverage, or
establish release readiness.

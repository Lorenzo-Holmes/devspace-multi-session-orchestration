# Current runtime lifecycle audit

Audited source baseline: `5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`.

This is an audit of the public review snapshot, not a claim about the deployed Windows host. `REVIEW_BRIEF.md` explicitly excludes runtime state, local deployment evidence, generated output and credentials.

## Entrypoints and shutdown

- `package.json`: development uses `tsx watch --clear-screen=false src/cli.ts serve`; production foreground startup uses `node dist/cli.js serve`. The package declares Node `>=22.19 <27` and pnpm `11.25.0`.
- `bin/devspace.js` delegates to the compiled CLI.
- `src/cli.ts`, `serve()`: validates the SQLite native dependency, loads configuration, calls `createServer`, listens on the configured host/port and registers SIGINT/SIGTERM shutdown handlers.
- Shutdown delegates to `src/server-shutdown.ts`. Foreground CLI startup is not an external crash-recovery supervisor.
- `src/server.ts`: owns MCP transports and their bounded idle cleanup. A client transport disconnect is not evidence of process failure.

## Existing supervisors: do not conflate their authority

- `src/orchestration-supervisor.ts` and `src/supervisor-contracts.ts` implement the read-only orchestration view. They are not process supervision and must not gain recovery or execution authority.
- `src/local-agent-daemon.ts` and `src/local-agent-daemon-lifecycle.ts` own the separate local agent daemon. The latter publishes `agentd.lock` using a hard link from a temporary file and records a numeric PID in lock/PID files. Its liveness check is PID-based; it does not establish process-birth identity. Its undecodable-lock handling already refuses automatic deletion.
- Do not reuse the agent daemon's PID-only lock as server runtime identity, and do not change agent/task ownership in this workstream.
- Deployment guard scripts reference `start-devspace.ps1`, `supervise-devspace.ps1`, `.devspace-release.json` and `.devspace-process.json`. The root tree of this public baseline does **not** contain those PowerShell entrypoints or runtime metadata. Fetching `supervise-devspace.ps1` at the baseline returns 404. Their deployed implementation cannot be audited from this snapshot.
- An opt-in runtime implementation must therefore not overwrite, remove, silently replace, or run concurrently with that external production supervisor. Deployment wiring remains a separate, explicitly approved integration with workstream B.

## Existing health and deployment identity

`scripts/orchestration-v2-runtime-probe.mjs` demonstrates the existing contracts:

1. Read the approved deployment pointer's `entryPoint` and `buildId`.
2. Require HTTP `/healthz` to return 200.
3. Initialize an official MCP client and list tools.
4. Read `devspace_runtime_info` and compare its build identity, tool count and sorted-name fingerprint.

`src/server.ts` defines server version `0.1.0+tools.20260919.4`, schema version `2026-09-19.4`, and an in-process startup timestamp. An in-process timestamp is not an OS process-birth token and cannot by itself prevent PID reuse.

The deployment probe performs an owner-token authorization flow. A recovery loop must **not** copy that behavior to silently approve OAuth. Health checks must use an already approved credential or stop at an authentication boundary. Process existence or an open TCP port alone is insufficient recovery success.

## Cloudflare, CUA and browser boundaries

- The inspected source does not establish an in-repository cloudflared supervisor. Ownership must be explicit. External tunnels are observed only; they must not be adopted or killed based on an executable name.
- `src/codex-cua-bridge.ts` discovers the bundled Windows CUA sidecar from the Codex plugin cache. It checks absolute paths, launch-path containment, the native pipe prefix, and the direct runtime's declared module-root containment.
- Direct CUA connections and browser/REPL connections are separate. Direct-session teardown clears references before awaiting close. Browser connections cache a client, transport and initialization state; rediscovery must preserve serialization and must never replay a possibly executed browser action.
- Discovery does not make DevSpace the supervisor of Codex itself. Reconnect must continue through existing trusted-path checks and existing elicitation/approval handling. No browser settings, extensions, MFA or OAuth approvals may be changed automatically.

## Validation availability

The existing `.github/workflows/ci.yml` runs frozen installation, typecheck, tests and build on Ubuntu, macOS and Windows for pull requests. It must not be modified by this workstream.

At audit time the editing container provides Node `22.16.0` and TypeScript `5.8.3`, lacks pnpm, and cannot resolve `github.com` for `git clone`. Those are execution-environment limitations, not GitHub write-permission failures. Local isolated checks and remote project checks must be reported separately; historical baseline counts in `REVIEW_BRIEF.md` are not new validation results.

## Scope decision

Runtime recovery state must live in an explicitly selected runtime-owned directory, separate from the user's workspace and orchestration databases. Recovery may reconcile infrastructure, fence old runtime generations, and perform bounded restarts of the approved build. It must not mutate Git, task/session/attempt authority, integration/evidence/worktree semantics, release pointers, UI, conversation epochs, or diagnostics reports.

# Runtime operations

Do not deploy this draft solely because isolated tests pass. Full-project CI and host-specific acceptance remain required. Do not run the new supervisor alongside the existing production PowerShell supervisor or an independently configured second runtime state directory.

## Provisioning

Use an approved, immutable, already built release. Confirm that `dist/runtime-supervisor/*`, related compiled modules, `bin/devspace-runtime.js`, and `scripts/runtime-resilience/native-process.ps1` are available at their expected relative paths. Packaging changes are not included here. Use the project's declared Node/package-manager versions for project validation.

Create a private runtime state directory outside workspaces. On POSIX it must be owned by the executing user with no group/other access. On Windows configure the equivalent restrictive ACL as an operator step. Provision an already approved health credential in the process environment; never store it in the runtime JSON or commit it.

Illustrative Windows configuration (paths and version must be replaced with existing approved values):

```json
{
  "stateDirectory": "C:\\DevSpaceRuntime\\instance-a",
  "instanceRoot": "C:\\DevSpace",
  "activeReleaseFile": "C:\\DevSpace\\active-release.json",
  "serverVersion": "<approved-server-version>",
  "localUrl": "http://127.0.0.1:4317",
  "healthTokenEnv": "DEVSPACE_RUNTIME_HEALTH_TOKEN",
  "runtimeRecovery": { "enabled": false },
  "tunnel": { "ownership": "external" }
}
```

The existing approved pointer must contain `entryPoint` and `buildId`. The entrypoint must be inside `instanceRoot`. Do not create or overwrite the production pointer merely to match this example. Local readiness requires an explicit 127.0.0.1 HTTP origin/port. Remote readiness, when configured, requires an approved HTTPS origin. Recovery is disabled until the operator deliberately enables it; changing a loaded configuration requires a coordinated supervisor handoff.

## Commands

From the built installation, substitute one absolute configuration path:

```text
node bin/devspace-runtime.js run --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js status --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js dry-run --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js pause --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js resume --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js restart --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js stop --config C:\DevSpaceRuntime\runtime.json
node bin/devspace-runtime.js upgrade --config C:\DevSpaceRuntime\runtime.json
```

`status` and `dry-run` require an existing journal and read persisted observations; they are not fresh health probes. Control commands write durable intent. `resume` reconciles an existing runtime before launching and does not reset budget. `restart` drains before replacing and remains subject to enabled policy and budget. `upgrade` stops only; another approved deployment mechanism must perform any release change.

SIGINT/SIGTERM to the supervisor requests durable stop. Clean shutdown requires all managed components stopped. A refused safe termination or incomplete shutdown must be investigated rather than hidden by deleting the journal.

## Triage

For `BLOCKED_PORT_CONFLICT`, identify the listener and its owner outside this recovery loop; do not kill it by name. For identity/metadata uncertainty, preserve the database and processes for investigation. For `WAITING_FOR_USER_APPROVAL`, complete the normal approved authentication/elicitation process. For `CRASH_LOOP`, inspect failure records and fix the underlying cause before explicit resume. A native tunnel publication gap needs ownership reconciliation before any new launch.

The existing `.devspace-supervisor.lock` causes a fail-closed startup block. No automatic removal or production-supervisor migration is provided. Foreground startup remains available under its existing procedure after a deliberate handoff; do not run it concurrently with an owned supervised runtime.

## Validation commands

Use the repository's frozen install, typecheck, tests and build on a complete checkout. The real isolated runtime smoke additionally runs after compilation:

```text
node scripts/runtime-resilience/isolated-smoke.mjs
```

The smoke starts only a temporary fixture, deliberately crashes that fixture, verifies recovery and intentional stop, and removes its temporary state. It does not validate the deployed DevSpace release or manipulate production Cloudflare/Codex processes.

# Windows startup options and deployment handoff

No startup mechanism is installed by this branch. Existing deployment PowerShell supervision was not present in the audited public snapshot, so an automatic migration would be unsafe. Workstream B and the operator must choose one owner for each installation.

## Foreground or operator-launched mode

Use the existing foreground startup for development under its current procedure, or explicitly launch the optional built runtime entrypoint. Do not run both against the same service port. The new supervisor refuses startup when it sees the legacy `.devspace-supervisor.lock`; it does not delete or reinterpret that lock.

## Scheduled Task

A separately approved Scheduled Task can invoke a fixed Node executable and `bin/devspace-runtime.js run --config <absolute-config>`. Provision its account, working directory, approved environment credential, restrictive state-directory ACL and single-instance policy explicitly. Do not embed the bearer token in a task argument or a repository file. Account for whether an interactive desktop is needed by separately owned Codex/browser components; a background task is not proof of their availability.

## Service integration

A Windows Service integration requires an approved service host/wrapper and explicit stop semantics. This implementation does not install or select one and does not claim that an arbitrary Node CLI is itself a Windows Service. A service manager must not compete with another supervisor or create its own uncontrolled restart storm.

## Handoff checklist

First validate the final build and host tests. Stop the existing owner intentionally and verify its registered processes/listeners are reconciled. Provision one canonical runtime directory and the already approved release pointer; never modify the pointer from recovery code. Test start, full MCP readiness, crash recovery, intentional stop, credential expiry and blocked ownership. Only then enable an approved OS startup trigger.

Persistent `stop` or `upgrade` intent remains stopped after the OS launcher starts the supervisor again. Reboot is not implicit permission to resume tasks or override operator intent. Changing the approved configuration/release requires a deliberate stop and handoff; no in-loop upgrade or rollback is performed.

Production suspend/resume/reboot acceptance and coordination with the existing PowerShell launcher remain outstanding. Retain a documented operator procedure that does not erase uncertain journals or kill processes by name.

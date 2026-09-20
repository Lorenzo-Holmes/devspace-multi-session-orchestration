# Integration generation and isolated merge observations

Status: implementation checkpoint. Focused integration, TestRun, migration and
server-telemetry regressions pass; full repository validation is required before
this checkpoint can be called merge-ready.

An evaluation first commits a new generation with both readiness flags false.
It captures the current task, session and workspace binding, rather than using
the integration record's historical binding as current authority. External Git
work runs outside SQLite transactions. An immediate final transaction rechecks
the evaluation revision/generation and the captured task/session/binding. A
concurrent review update wins; the old evaluator cannot overwrite it. Other
changed authority or moved Git inputs produce a stale, non-ready observation.
An interrupted evaluation remains `running` and non-ready; retry with its current
revision reserves a successor generation.

`targetRef` defaults to `HEAD` in the **source** checkout. `candidateRef` defaults
to `HEAD` in the task worktree. Both are resolved to immutable commit/tree IDs.
The probe requires a common Git repository, runs `merge-tree --write-tree` in an
invocation-owned temporary bare repository, and reads source objects through an
alternate. It changes no source refs, indexes, worktrees or object databases.
Only its own temporary directory is removed. Conflict, unsupported policy and
execution failure are distinct; unknown is never clean.

The declared merge policy is `isolated-ort-v1`. Custom merge configuration,
configured attribute files and repository-local attribute overrides block the
probe instead of executing user merge commands or silently accepting a different
policy. A future merge executor must enforce the same policy and exact OID pair.
The temporary merge-tree OID is not promised to remain available after cleanup.

Source observations disable the optional filesystem-monitor helper and reject
actual file attributes selecting a source filter before inspecting worktree
status. Installed but unused filters, including Git for Windows' default LFS
registration, do not block ordinary repositories. Attribute selection is read
without running a filter. Neither observation nor merge simulation should launch
those user helpers.

Git inputs are observed again before the database commit. This detects movement
during the probe, but does not lock an arbitrary external Git writer after the
last observation. `checkedAt`, the OID pair and generation identify a historical
observation, **not perpetual merge permission**. No merge executor is added.

The integration's internal session and conflict reads are complete rather than
limited to UI history pages. Integration updates now accept only scoped
execution-issued Evidence IDs. Each accepted Evidence binds the validated commit
and tree plus the worker incarnation, binding generation and file generation;
legacy caller-supplied event/commit associations are read-only compatibility data
and are not authoritative. A candidate advance after validation therefore fails
the evidence gate even if a caller reuses the older Evidence ID.

The TestRun journal separates `started`, `running`, `passed`, `failed`,
`cancelled` and `unknown`. `exec_command` records process identity and hard-timeout
facts; `write_stdin` completes the same run. Exit zero is insufficient by itself:
the source observation and execution authority must still match, and Node test
runs require a positive non-zero test receipt. Help output and keyword-only
commands do not create successful validation facts. Session health separately
tracks attempts, successful validation, failures and the validated file
generation, so a failed test cannot clear `unverified_changes`.

Logical-session/attempt ownership beyond these generation fences and handle-level
filesystem containment remain separate prerequisites. Automatic conversation
rollover must stay disabled until those prerequisites are closed.

Regression source: `src/integration-generation.test.ts`. It includes real Git
same-line, rename/delete, delete/modify, binary and clean merges; untouched index
and ref checks; task/session/binding/target/candidate/review barriers; trusted
Evidence lookup past bounded event history; stale commit rejection; and
conservative custom-driver/filter rejection. `orchestration-validation.test.ts`,
`process-sessions.test.ts`, `session-migration.test.ts` and the server telemetry
regression cover the TestRun/Evidence lifecycle. Focused barriers are not a
substitute for real process-kill or browser E2E acceptance.

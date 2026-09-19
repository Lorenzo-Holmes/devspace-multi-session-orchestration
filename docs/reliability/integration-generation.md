# Integration generation and isolated merge observations

Status: implementation checkpoint; focused and full validation pending.

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

Git inputs are observed again before the database commit. This detects movement
during the probe, but does not lock an arbitrary external Git writer after the
last observation. `checkedAt`, the OID pair and generation identify a historical
observation, **not perpetual merge permission**. No merge executor is added.

The integration's internal session and conflict reads are complete rather than
limited to UI history pages. Evidence events use a session-scoped exact-ID query
and a kind-filtered latest-event query. These changes fix prefix starvation, not
the separate A1/A2 trust defect: legacy caller-supplied event/commit associations
are still present. They must not be described as trusted execution evidence.
Logical-worker/attempt fencing and handle-level filesystem containment remain
separate prerequisites. Automatic conversation rollover must stay disabled.

Regression source: `src/integration-generation.test.ts`. It includes real Git
same-line, rename/delete, delete/modify, binary and clean merges; untouched index
and ref checks; task/session/binding/target/candidate/review barriers; event lookup
past 501 later observations; and conservative custom-driver rejection. Barrier
tests are not real process-kill or browser E2E acceptance.

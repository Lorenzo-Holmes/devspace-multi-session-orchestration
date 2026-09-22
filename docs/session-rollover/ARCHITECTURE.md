# Session rollover architecture

**Status: design + isolated helpers; dependency-blocked, not an implementation of unattended rollover.**
The audited base is recorded in [current-capabilities.md](current-capabilities.md).
Do not enable browser actions, add migrations or manufacture alternate identity models
until reliability's canonical domain types and mutation fencing are available.

## Lifecycle ownership

A Project owns long-lived LogicalSessions. A LogicalSession owns ordered ConversationEpochs;
each epoch refers to a WorkerIncarnation from reliability. ExecutionAttempts also belong to
reliability, not this module. Conversation ID/URL are host identifiers, never the logical-session
primary key. Replacing a conversation must preserve task state, decisions and evidence history.

The future ConversationEpoch extension should record project scope, logical session,
epoch number, host conversation ID/URL, verified account/workspace reference, worker incarnation,
source epoch/handoff, reason, generation and creation/activation/supersession/end timestamps.
This is a design contract only: no parallel TypeScript entity or SQL table is defined yet.

## What is implemented now

`src/session-rollover/policy.ts` validates standalone conservative opt-in settings and
computes advisory eligibility from supplied history. `signals.ts` classifies structured
observations and errors without inferring context overflow from a disconnect.
`safety.ts` checks complete fresh safe-point observations and exact browser/security/identity
preconditions. `bootstrap.ts` produces a deterministic fixed prompt with bounded identifiers
and a SHA-256 fingerprint. None imports a DB, server, launcher, process runner or scheduler.

`eligible`, `safe` and `ready` are **advisory, not authorization**. The helpers are not
registered as tools or project configuration. Caller-supplied booleans, counters or IDs
cannot establish ownership, user consent or trustworthy host observations.

## Required integration sequence

1. Consume reliability's canonical domain types and trusted request identity. Audit every
   current-state mutation, including late results/acknowledgements; not just task completion.
2. Reserve one RolloverAttempt per scoped logical session under durable uniqueness/CAS.
   Count reservations/attempts, not only successful chats, so failures consume bounded budget.
   Acquire bounded global and per-project slots transactionally (proposed defaults: one each).
3. Stop new conflicting mutations through reliability's reservation boundary; obtain a safe
   point and a structured durable checkpoint. Reuse HandoffManager, adding rollover references
   only after its authority/acknowledgement semantics are stable.
4. Persist intent BEFORE each external browser effect. Preflight exact authorized target,
   account/workspace, origin/security, plugin and catalog, then use the supported UI.
5. Receiver loads durable state and scoped memory, verifies workspace/repository/branch/worktree/
   commit/dirty state, observes old processes and registers the canonical incarnation.
6. One shared DB transaction checks expected source epoch, generation, session revision,
   worker, task/attempt authority, checkpoint revision and intended handoff/target binding.
   It switches source/G to target/G+1, fences source, activates target and commits journal state.
7. After commit, continue from nextAction. Historical process results remain inspectable;
   they become current evidence only if reliability's attempt/generation validation permits it.

## Required persistence, not yet added

Proposed extensions: conversation_epochs, rollover_attempts, rollover_checkpoints and scoped
rollover policy storage. Use foreign keys/scoped lookup constraints, ordered unique epoch numbers,
unique active attempt per logical session, one authoritative current pointer and bounded history
pagination. Append migrations after reliability's then-current version; never edit old migrations
or assume version 19 is available. Old DB migration/restart tests are an integration gate.

Each attempt needs rolloverId, scope, source/target epochs, reason/trigger, phase/resumePhase,
checkpoint/handoff, expected source revision/generation/attempt, browser/tab/conversation IDs,
bootstrap fingerprint, retry counters, deadlines, last bounded redacted error and timestamps.
Durable reservations need fencing across two processes and two DB connections, not a JS mutex.

## Checkpoint and capsule design

A checkpoint contains schema version/revision/time; scoped logical session/source epoch;
project/workspace/repository/branch/worktree/current commit/tree and dirty-state digest;
objective/current task/attempt; completed task IDs; current implementation state; recent commits;
source-attributed decisions and constraints; blockers; active process IDs with original ownership;
validation/evidence references; pending approvals; relevant paths; handoff references; nextAction.
Preserve unknown dirty work. Store bounded references to large logs, not the logs themselves.

Maintain lightweight structured checkpoints at significant transitions, commits, completed tests,
handoffs and safe points. Do not depend on a last-minute LLM summary when a conversation dies.
Project memory and a decision ledger remain separate durable sources. No full transcript, secrets,
account data or unrelated project memory belongs in a checkpoint/capsule.

A future capsule is deterministic bounded data derived from the checkpoint, with a schema version
and fingerprint. It is loaded through authenticated scoped DevSpace access, not pasted into the
bootstrap. Only bootstrap formatting/hashing is implemented here; checkpoint/capsule persistence,
canonical serialization and redaction tests remain integration work.

## Runtime boundary

No existing watchdog recovery loop was found. If no suitable loop emerges from reliability,
a single optional server-owned controller must use bounded ticks, durable leases/backoff,
restart reconciliation, graceful cancellation/shutdown and no duplicate timer. Do not reuse
MCP transport cleanup as a scheduler or expand this into a general autonomous task runner.
Never fabricate active-turn metadata to invoke a Browser Use bridge outside its supported context.

Read [STATE-MACHINE.md](STATE-MACHINE.md), [RECOVERY.md](RECOVERY.md) and [SECURITY.md](SECURITY.md)
before wiring any of these pure helpers to external actions.

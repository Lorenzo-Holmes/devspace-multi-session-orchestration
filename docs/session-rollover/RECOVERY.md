# Crash and recovery design - integration pending

Browser UI effects are not transactionally coupled to SQLite. This design does not promise
exactly-once conversation creation. Stable rolloverId, fixed bootstrap fingerprint, durable
before-effect intent, observed target persistence and fail-closed reconciliation limit duplicates.
The current branch implements none of the journal persistence or recovery controller below.

| Crash point | Required restart strategy |
| --- | --- |
| A: reservation, before browser | Load same attempt; reacquire fenced lease, refresh policy/source authority and safe point; do not reserve another attempt |
| After checkpoint / after handoff | Verify linked scoped immutable revisions and reuse them; never regenerate incompatible state under the same fingerprint |
| B: New Chat opened, before prompt | Re-observe the exact reserved browser/tab; bind only a uniquely verified target. If creation cannot be determined, recovery_uncertain, no second chat |
| C: prompt filled, before send | Observe exact target and fixed prompt presence/fingerprint. If message already sent or state ambiguous, do not send again |
| D: prompt sent, before URL persisted | Reconcile same tab using observed bootstrap confirmation + rollover binding. A URL alone is insufficient; no blind re-send/re-open |
| After URL persistence | Verify target account/workspace, actual bootstrap presence and durable target identity before waiting for handshake |
| E: new conversation running, before handshake | Wait/reconcile the existing attempt under deadline. Plugin failure/no handshake cannot grant authority or trigger duplicate creation |
| F: handshake ready, before CAS | Revalidate all readiness/source authority checks and perform one compare-and-swap; readiness is not ownership |
| G: takeover committed, before source marker | Read committed current pointer/generation. Source fencing already committed atomically; rebuild the non-authoritative marker/event idempotently |
| Server restart at any phase | Resume only durable intent. In-memory timers, flags or lock ownership cannot establish what happened |

A future implementation must inject crashes at every listed boundary, including commit-before-response,
using two database connections and a fake launcher with separately retained effect state. Restarting
only a JavaScript object without reopening persistence is not a durable recovery test.

## Healthy source and old processes

A healthy source remains current when target creation, plugin connection, handshake or CAS fails.
Never revoke source ownership merely because a bootstrap was sent. A source conversation that becomes
unusable still does not justify duplicate mutation while its command/test/git operation is running.
Reconcile filesystem, worktree, command status and stored results first.

Do not kill commands, builds or tests, delete worktrees, stash/reset/clean changes or force checkout.
Retain original process/attempt ownership. Late results can be historical/stale; current Evidence
requires the current generation/attempt rules. Unknown dirty state requires reconciliation before writes.

## Recovery decision and loop prevention

A future durable RecoveryDecision should record timestamp, scoped signals and reason, with outcomes
healthy/wait/rollover_candidate/blocked/waiting_approval/uncertain. Require grace period plus corroborating
host/browser/task/process/journal state and a verified fencing path; heartbeat age is activity metadata only.

Use max attempts, consecutive failure pause, minimum interval and cooldown from the policy helper.
The controller must persist and atomically enforce those counters and global/project capacity.
A recovered unknown effect stays reserved until resolved. Approval wait is not silently converted into
permission or repeated New Chat attempts. Exponential backoff may be added without weakening caps.

On two default consecutive recovery failures, report PAUSED_NEEDS_ATTENTION. Require an explicit
operator reconciliation decision before clearing uncertainty, resetting budgets or rearming recovery.
None of these operator controls or the controller are implemented in this branch.

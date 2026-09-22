# Proposed state machine - not yet persisted or executed

The state machine below is an integration design. No RolloverAttempt or ConversationEpoch
store/controller exists in this preparatory branch. A helper returning `eligible` does not
advance this machine.

## RolloverAttempt

| Phase | Entry requirement / permitted next action |
| --- | --- |
| reserved | Durable unique attempt, expected source authority and bounded capacity slot acquired |
| safe_point_wait | Block conflicting new mutations; wait for fresh complete operation observations |
| checkpointing | Reserve checkpoint operation; no external chat effect |
| checkpointed | Durable structured checkpoint and existing-system handoff linked |
| browser_preflight | Fresh exact browser/tab, origin, account/workspace, plugin/catalog and approval checks |
| opening_chat | Durable intent BEFORE UI New Chat; retain source/current authority |
| chat_created | Persist target tab and observed provisional host state |
| bootstrap_filling | Durable fill reservation using fixed prompt and stable rolloverId |
| bootstrap_sent | Send confirmed; do not infer delivery solely from a URL |
| handshake_waiting | Bind actual receiver conversation to reserved scope/handoff/rollover |
| takeover_ready | All workspace/task/attempt/process checks complete; still no new ownership |
| takeover_committed | Atomic authority + generation + source fencing + journal transaction committed |
| source_superseded | Read model/notification projection; not a second authority transaction |
| completed | Target owns current execution; release capacity only after durable resolution |
| waiting_user_approval | Persist exact blocker and resumePhase; no automatic consent |
| recovery_uncertain | An effect/identity/authority is ambiguous; retain deduplication reservation |
| failed | Definitively failed, no ambiguous external effect; bounded failure policy applies |

Safe-point, bootstrap and takeover timeouts are bounded waits, NOT permission to guess success,
steal an owner or resend. An uncertain attempt cannot simply be labelled failed and replaced.
Persist separate bounded reason codes for blocked account identity, stale catalog, workspace
reconciliation and browser security, rather than treating all errors as recoverable context failure.

## ConversationEpoch

Proposed states: creating, bootstrapping, ready, active, rollover_preparing, takeover_pending,
superseded, failed, waiting_user_approval and recovery_uncertain. The source remains authoritative
until the takeover transaction succeeds. A target that is ready, failed or waiting approval is
never current. Source supersession and target activation share the same authority commit.

The authoritative source of truth is the scoped current pointer/generation, not host URL presence,
AX text saying "ready", a heartbeat, a status card or an eventual source-superseded event.

## Implemented policy and signal semantics

Default standalone policy: disabled, automatic mode when explicitly enabled, recovery disabled,
maximum six reservations per logical session, two consecutive recovery failures, minimum fifteen
minutes between starts, thirty-minute failure cooldown. Wait limits: 120s safe point, 120s bootstrap,
60s takeover. Config validation rejects zero/unlimited caps, malformed values and unknown keys.
These are helper defaults, not a currently recognized server config feature.

Known counters and fresh observations only: low/moderate/high/rollover_recommended/critical/unknown.
Age alone reaches at most moderate. One high volume counter is low-confidence high; two different
high volume dimensions recommend rollover with moderate confidence. An explicit structured host
context-length error is critical/high confidence. Volume heuristics are not actual token usage.
Missing/stale/future observations do not authorize actions. Duplicate snapshots do not accumulate.

A production controller must translate only configured eligible observations to triggers.
Network/host transient errors retry the existing conversation under a separate bounded policy.
Heartbeat staleness alone is not a trigger. Manual debugging never bypasses limits or safety checks.

## Mandatory future concurrency invariants

Per logical session there is at most one current epoch, one current authoritative incarnation per
generation and one active rollover reservation. Across processes only one CAS may succeed from
source/G. Replayed bootstrap does not create authority. Old results/acks cannot confirm the new
generation. These must be proven with real DB concurrency/crash tests before enabling the runtime.

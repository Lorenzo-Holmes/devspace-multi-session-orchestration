# Recovery policy

Recovery is disabled by default. Configuration accepts known keys only and rejects invalid or inconsistent bounds. Enabling recovery does not authorize release selection, credential approval, task replay, or unowned-process termination.

| Setting | Default |
| --- | --- |
| `enabled` | `false` |
| `windowMs` | 600000 |
| `maxRestartsPerWindow` | 4 per component |
| `maxGlobalRestartsPerWindow` | 8 |
| `initialBackoffMs` / `maxBackoffMs` | 2000 / 60000 |
| `healthyResetMs` | 300000 |
| `healthTimeoutMs` / `stopTimeoutMs` | 30000 / 15000 |
| `pollMs` | 2000 |
| `resumeThresholdMs` / `resumeGraceMs` | 30000 / 15000 |
| `eventLimit` / `attemptLimit` | 256 / 32 |

Initial starts and manual restart launches also consume budget. Backoff is exponential with a bounded 0.75-1.25 multiplier and a configured cap. Restart history is rolling, not lifetime. Sustained healthy operation clears that component's penalty/history and corresponding global entries. A manual resume is not a budget reset.

## Classification

| Failure | Automatic response |
| --- | --- |
| Verified managed server crash | Bounded restart of the same approved build |
| Verified managed tunnel crash | Bounded component restart after server readiness |
| External tunnel unavailable | Observe/degrade; do not adopt or terminate |
| Network transient | Retry observation/back off; do not infer an ownership change |
| Typed browser transport disconnect | At most one retry of a read-only operation on a fresh transport |
| Possibly executed browser mutation | Return failure/uncertain outcome; never replay |
| Browser security, MFA or authentication boundary | Wait for user/operator action; no workaround |
| Unknown port owner or uncertain process identity | Block |
| Invalid config, changed release or resource exhaustion | Block; do not repair or switch release |
| Exhausted rolling budget | Pause with `CRASH_LOOP` |
| Intentional pause, stop or upgrade | No automatic launch |

## Independent browser budget

Browser recovery uses three failures per 60 seconds, a 500 ms backoff, a queue bound of 16 and a 1500 ms teardown wait. A timed-out or failed teardown fences replacement creation. The existing transport's request/approval semantics are retained; no new autonomous browser-action timeout/replay loop is added.

## Read-only planning

`dry-run` evaluates the last committed snapshot, does not probe the host, does not write a reservation and does not authorize execution. A recorded live identity is reconciled before a proposed replacement. The operational adapter must still satisfy current identity, release, resource and credential checks.

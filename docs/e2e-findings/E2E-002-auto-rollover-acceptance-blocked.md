# E2E-002 — Unattended Auto Rollover cannot enter product acceptance

- Severity: high for the unattended-continuation goal
- Owner branch: `pro/auto-session-rollover`
- Status: NOT_IMPLEMENTED / BLOCKED

The current rollover branch contains policy, signals, safety, bootstrap and
design documentation, but not a durable ConversationEpoch/RolloverAttempt
controller with real Browser Use takeover. In addition, A currently records a
remaining handle-level directory-replacement containment blocker.

Expected acceptance is Epoch 1 → checkpoint → new ChatGPT conversation →
handshake → atomic takeover → old-epoch fencing → Epoch 2 continuation.
H cannot truthfully run that journey today and records it as NOT_IMPLEMENTED,
not PASS or a fake-adapter E2E.

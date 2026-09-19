# Windows sleep, resume and restart reconciliation

The supervisor detects large forward or backward wall-clock discontinuities. At the default 30-second threshold it records `resume_reconciliation`, establishes a 15-second grace interval, and resets continuous health/unhealthy observations. It first reconciles process identity and readiness rather than restarting every dependency simultaneously.

This is a polling heuristic. It is not a native Windows power-event subscription and cannot distinguish sleep from every form of scheduling delay or clock adjustment. Persisted monotonic readings are not used as cross-process or cross-boot identity.

## Resume

A surviving owner is not replaced because its heartbeat is old. A surviving managed server must retain the expected birth/build/root identity and regain HTTP/MCP readiness. A missing server is classified and budgeted normally after the reconciliation grace. External tunnel/Codex/browser ownership does not change because the machine slept.

Backward wall changes do not advance policy time or manufacture a healthy-reset interval. A clock that remains behind may conservatively delay deadlines until wall time catches up; an operator should correct the host clock rather than erase runtime state.

## Reboot or dirty shutdown

The runtime journal survives independently of the worker. A subsequent approved OS launch attempts owner acquisition, reconciles old process identities and examines pending tickets. Linux includes boot ID in process identity; Windows uses creation time and executable through its native handle backend. A matching orphan is health-checked before adoption. An ambiguous native tunnel launch blocks rather than duplicates.

A persistent stop/upgrade intent is honored after restart. Reboot does not authorize task execution, conversation rollover, release switching or OAuth/browser approval.

## What is not installed

No Windows Service, Scheduled Task, startup shortcut, power-event listener or external watchdog is installed by these commits. Automatic reboot startup requires a separately approved operator/deployment configuration; see `windows-startup-options.md`.

Tests include an accelerated two-hour sleep, backward clock movement and a 24-hour mixed-fault simulation. These are deterministic simulations, not a production Windows suspend/resume, reboot acceptance run or real 24-hour soak.

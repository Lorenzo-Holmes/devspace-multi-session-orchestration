# MULTI-SESSION-ORCHESTRATION-V1

DevSpace V1 adds a durable local coordination plane for multiple workers or Chat sessions operating on the same project.

## Capabilities

- Persistent session registry in the existing DevSpace SQLite state database.
- Explicit states: `queued`, `running`, `blocked_user`, `blocked_tool`, `waiting_test`, `ready_review`, `completed`, `failed`, `abandoned`.
- Metadata-only heartbeats and append-only activity events.
- Derived observational health: `healthy`, `idle`, `stalled`, `blocked`, `retry_loop`, `unverified_changes`, `terminal`.
- Bounded file-intent declarations and deterministic conflict detection.
- Project-scoped MCP tools for registration, heartbeat/update, list/status/events/health/conflicts.
- Persistence across DevSpace restart.

## MCP tools

Mutation of orchestration metadata only:

- `session_register`
- `session_heartbeat`
- `session_update`

Read-only monitoring:

- `session_list`
- `session_status`
- `session_events`
- `session_health`
- `session_conflicts`

The metadata mutation tools do not modify repository files, run shell commands, start or wake models, merge branches, kill processes, or change filesystem permissions.

## Conflict model

V1 compares active sessions only when they share the same project key and the same workspace root. This intentionally treats separate worktrees as isolated even when relative filenames match. A conflict requires exact or parent/child path-scope overlap and at least one `write` intent. `write/write` is `high`; `read/write` is `medium`; `read/read` is not a conflict.

## Heartbeat semantics

A heartbeat means only that some caller recorded local coordination metadata at a timestamp. It does not prove that a ChatGPT conversation, local agent, process, or model is still running. It cannot wake a Chat turn or keep a host request alive.

## Goal separation

The multi-session registry is independent of Chat Goal card transport. Ordinary file operations such as `open_workspace`, `search_files`, `list_directory`, `file_info`, `read`, and `batch_read_files` must not be routed through `chat_goal_preflight` or Goal connection-card handshakes unless the user actually requested Goal work.

## V1 non-goals

V1 does not automatically:

- create new ChatGPT conversations or Codex threads;
- call background models;
- retry stalled work;
- terminate processes;
- merge worker branches;
- resolve conflicts;
- grant or escalate permissions;
- claim that a worker is alive solely from a heartbeat.

Those capabilities require a later coordinator/scheduler layer with explicit host support and additional human-approval boundaries.

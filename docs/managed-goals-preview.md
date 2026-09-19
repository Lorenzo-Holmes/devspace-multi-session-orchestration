# Managed Goals preview

The text-only MCP entry exposes `goal_start`, `goal_status`, `goal_list`, `goal_pause`, `goal_resume`, and `goal_stop`. Enable it explicitly with `goals.enabled`, an absolute original-Shrimp `shrimpEntryPoint`, a dedicated `dataRoot`, and optionally a verified `codexCommand`. The normal single-turn tools remain unchanged when the feature is disabled.

The existing single-user OAuth verifier supplies ownership. A model cannot supply `ownerRef`. A new authorized OAuth client can recover the same owner's Goals. Temporary conversation grants are insufficient for background work. Project authorization is rechecked on controls, task writes, and the daemon health cycle. After access revocation, the owner can still request pause/stop without reading project artifacts.

The existing daemon holds the native runtime across turns and browser disconnects. Native Codex alone starts new turns. A binding stores the thread ID, dedicated Shrimp directory, creation intent, control receipts, specification and timestamped observations in the existing DevSpace SQLite database. No second task database is introduced. Read cached native observations alongside their timestamp and runtimeConnected flag; they are not live-process proof.

## Preview boundary

- Start only in a dedicated empty project. Resume existing work by Goal ID. No auto-enrollment of existing repositories or dirty user files.
- Local file-generation work only. External apps, publishing, package installation, other projects, subagents and extra privileges are not part of this preview's authorization.
- Native requests for additional approval are cancelled and the Goal pauses with `NATIVE_APPROVAL_REQUIRED`. The broken historical approval-widget round-trip has not been declared fixed or replaced by forged grants.
- Independent code verifies real file bytes/hashes and records code/task commits. A successful native command item can be linked as evidence. This verifies artifact existence/integrity and command exit, **not the semantic correctness of arbitrary user requirements**. A native completed Goal displays `artifact_checks_recorded_user_acceptance_required` until the user actually evaluates the deliverable.
- Graceful daemon restart resumes the same thread and tasks. An unconfirmed crash is fenced as `RECONCILIATION_REQUIRED`, not blindly restarted. No claim of exactly-once external side effects, arbitrary crash recovery, or a completed ten-minute offline test.
- Three native turns without persisted task-state progress pause with `NO_PROGRESS`; this conservative preview may require a smaller task plan for long investigations.
- Goal-enabled shutdown permits up to 90 seconds to confirm native interruption and drain task writes. Pause/stop requested states are not completion acknowledgements.

## Verification

`scripts/goal-web-entry-probe.ts` exercises real local OAuth authorization, HTTP MCP, the existing daemon client, native Goal and original Shrimp. It checks tool discovery, creation deduplication, A→B→C tasks, pause, new OAuth client/daemon recovery, continuation with the MCP consumer disconnected, no repeat of completed work, real artifacts and stop acknowledgement. This test is not the hosted ChatGPT connector UI.

Lifecycle unit tests additionally hold thread creation open to race six simultaneous starts against pause; they verify one writer, no activation after pause, stale callback fencing and rejection of unconfirmed crash replay. Those are controlled test doubles, not provider scheduling evidence.

The native adapter follows [OpenAI's App Server contract](https://learn.chatgpt.com/zh-Hans/docs/app-server) and the installed runtime's schema. Re-run the native acceptance after upgrading the executable or changing its configured path.

## Release and rollback

Deploy immutable release directories. A local `.devspace-release.json` pointer selects the compiled CLI; its absence preserves the existing `dist/cli.js` startup. Keep the previous built release and original starter/config as a recoverable local backup. Do not copy OAuth credentials or tunnel state.

Schema migrations 8–9 are additive for pre-existing application data. An older build ignores the new Goal tables; rollback does not delete them or downgrade state. Stop/confirm all managed Goals before rollback. A running old daemon must not be silently replaced while another task is active.

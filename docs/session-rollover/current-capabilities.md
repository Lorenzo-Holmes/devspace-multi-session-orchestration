# Current capabilities: source-audited, dependency-blocked

## Audit boundary

Repository: `Lorenzo-Holmes/devspace-multi-session-orchestration`.
Audited reliability commit: `0cf912f400ec0835133aa50b0d30aaefe7af4c4e`.
Main at audit: `5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80`.
The reliability branch was two commits ahead, changing only `.github/workflows/ci.yml`
and `.github/workflows/hardening-workspace.yml`. Those changes provide validation
infrastructure, not the required session-identity implementation.

**Result: preparatory work only. Automatic continuation is NOT implemented.**
The requested dependency gate forbids a competing LogicalSession, WorkerIncarnation,
ExecutionAttempt or Handoff model. This branch adds only isolated pure helpers,
their tests and architecture documents. It does not wire them into the server.

The source was obtained from the existing `hardening-source` GitHub Actions artifact
(run `35441499886`, artifact `10583089626`); its bundle HEAD matches the audited commit.
The matching `hardening-runtime` artifact (`10583842458`) supplies Node 22.23.2 and
locked installed dependencies. No CI, deployment or release file was changed here.

## Findings verified against implementation

| Area | Actual implementation | Consequence for rollover |
| --- | --- | --- |
| Session identity | `src/orchestration-store.ts:27-46` defines OrchestrationSession; `orchestration-scope.ts:10-19` hashes project + trusted conversation ID; `orchestration-telemetry.ts:108-129` registers a `chatgpt_auto` session | Conversation replacement currently creates a different telemetry identity, not another epoch of a durable LogicalSession |
| Session writes | `orchestration-registry.ts:97-199` updates state, heartbeat and events; store updates do not require incarnation/generation | These writes cannot yet fence a superseded conversation |
| Task authority | `orchestration-coordinator.ts:93-174` claims/completes tasks using ownerSessionId, revision and leaseToken; `coordinator-store.ts` performs fenced task updates | Useful existing task CAS, but no ExecutionAttempt or WorkerIncarnation authority across all mutation surfaces |
| Handoff | `orchestration-handoff.ts:8-63` stores scoped bounded checkpoints and receiver acknowledgements; `orchestration-handoff.test.ts` tests receiver scope and restart | Reuse this manager after reliability hardening; acknowledgement is not atomic execution takeover |
| Storage | `orchestration-v2-store.ts:12-42` provides scoped JSON records, revision checks and immediate transactions | A future journal can use the shared database boundary; the current closed table union has no rollover tables |
| Migrations | `db/migrations.ts` currently ends at version 18; version 16 is handoff, 17 memory, 18 automation due-work | No migration is added or reserved in this preparatory branch |
| Project memory | `orchestration-memory.ts:16-35` provides revisioned project memory, with a 128 KiB bound | Reuse scoped project memory; do not copy it wholesale into a bootstrap |
| Browser inventory | `codex-cua-bridge.ts:208-223`, `codex-cua-tools.ts:329-366` enumerate actual browsers/tabs | Read-only enumeration exists; it does not create a conversation |
| Browser observation | `codex-cua-bridge.ts:225-238,506-521` resolves exact browser/tab and reads AX state plus current URL | Trusted IDs and accessibility observations are available when the host bridge works |
| Browser actions | `codex-cua-bridge.ts:240-253,524-563` exposes click_element, set_value, type_text and keypress | UI primitives can express fill/send; no audited ChatGPT-specific New Chat selectors, send confirmation or account/workspace verifier exists |
| Browser platform | `codex-cua-tools.ts:185-193`, `codex-cua-bridge.ts:565-566` require Windows; `server.ts:1625-1627` gates construction | This Linux verification environment cannot perform real Browser Use E2E |
| Browser approvals | `codex-cua-tools.ts:679-718` forwards elicitation or requires the approval-card path; `codex-cua-bridge.ts:449-460` cancels absent elicitation | Never fabricate acceptance or switch to desktop actions after Browser Use denial |
| Browser trust/identity | Browser inventory includes profileName and tab metadata, not a verified ChatGPT account/workspace principal | A production launcher must supply reliable account/workspace evidence or block |
| Watchdog | `orchestration-v2.ts:29-33` subscribes to changes; `orchestration-watchdog.ts:18-61` scans on invocation | Event-driven observation, not a periodic recovery executor |
| Automation | `orchestration-automation.ts:15-52` poll constructs durable due-work; acknowledge only changes delivery state | No background ChatGPT turn or new-chat launch |
| Timers | `server.ts:1668-1673` closes idle MCP transports; local-agent-daemon/runtime-pool timers manage local runtime lifecycle | Existing timers do not implement ChatGPT rollover reconciliation |
| Active processes | `process-sessions.ts` manages spawned processes and process-session retention | No durable rollover ownership transfer; do not start a second test/build or kill the first |
| Telemetry | `orchestration-telemetry.ts:137-158` records observed tool activity and validation-like commands | Heartbeat is observed activity, not model liveness or real context usage |

Local-agent and Goal infrastructure may execute explicitly requested local work;
that is distinct from an unattended controller creating ChatGPT conversations.
The presence of a timer or local agent is not proof of supported no-turn Browser Use.
Browser bridge methods require Codex turn metadata; supported execution without an
active model turn remains unverified and must not be simulated with fabricated metadata.

## Missing integration prerequisites

Reliability must first provide one canonical logical-session identity, worker incarnation,
execution attempt, project/session scoped current-state CAS, and stale-write fencing for
completion, evidence, integration, handoff/automation acknowledgements and heartbeats.
It must also expose safe-point/active-operation observations and a shared transaction
boundary for authority transfer. None is invented by the helper modules.

Production Browser Use additionally needs a supported unattended authorization context,
account/workspace verification, fresh accessibility-grounded ChatGPT UI actions, durable
external-effect reservations and receiver handshake binding. A preflight struct supplied
by arbitrary model arguments is not trusted evidence.

See [TEST-MATRIX.md](TEST-MATRIX.md) for measured results, baseline failures and explicit
non-coverage. The production counts in REVIEW_BRIEF.md are context, not results from this branch.

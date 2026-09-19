import { REVIEW_BASELINE } from "./catalog.js";
import type { RecommendationContext } from "./recommend.js";
import type { Role } from "./types.js";
export interface SelectionScenario { id: string; request: string; context: RecommendationContext; expected: readonly string[] }
/** Test-only recorded context. These booleans never bypass production checks. */
const READY: RecommendationContext = {
  role: "Worker", workspace: "modify", sessionKnown: true, taskKnown: true, revisionKnown: true,
  currentTaskAuthority: true, existingRecord: true, ownerKnown: true, targetFresh: true,
  realHumanChannel: true, durableGrant: true, explicitUserContinuation: true,
  userRequestedAction: true, humanGate: "not-required",
};
/** Independent, hand-reviewed oracles; no expected name is derived from the manifest. */
const CASES = `
Worker|workspace.open|open_workspace|Open the explicitly selected project checkout.
Observer|file.read|read|Read a known source file range without executing it.
Observer|directory.list|list_directory|Inspect directory entries without a shell listing.
Observer|file.inspect|file_info|Inspect metadata of one path.
Observer|file.batch-read|batch_read_files|Read several known small text files with per-file errors.
Observer|file.search|search_files|Find filenames or content matches without running commands.
Observer|database.inspect|query_sqlite|Read a bounded SQLite result without mutation.
Reviewer|changes.review|show_changes|Review the combined diff after related edits.
Observer|runtime.inspect|devspace_runtime_info|Inspect the reported runtime identity, not source contents.
Worker|access.request|request_workspace_access|Present a folder access decision for the human.
Observer|access.list|list_workspace_access|Inspect current grants before opening a folder.
Operator|access.revoke|revoke_workspace_access|Revoke an exact user-selected permission entry.
Observer|access.audit|workspace_access_audit|Read permission history without changing grants.
Worker|file.patch|apply_patch|Apply the explicitly requested relative-path patch.
Worker|command.execute|exec_command|Run the explicitly requested test command.
Worker|process.interact|write_stdin|Inspect or interact with an existing numeric shell process.
Worker|session.register|session_register|Register observation metadata for an existing worker.
Worker|session.heartbeat|session_heartbeat|Record activity without claiming worker liveness.
Worker|session.update|session_update|Update declared session intents, not project files.
Observer|session.list|session_list|List sessions rather than project tasks.
Observer|session.inspect|session_status|Inspect the current record of one scoped session.
Observer|session.events|session_events|Read recorded test events without treating them as verified evidence.
Observer|session.health|session_health|Inspect derived health without repairing anything.
Observer|session.conflicts|session_conflicts|Inspect declared path overlaps without locking files.
Coordinator|plan.create|coordinator_plan_create|Persist the explicitly selected dependency DAG.
Coordinator|task.list|coordinator_task_list|List tasks rather than registered sessions.
Coordinator|task.inspect|coordinator_task_status|Inspect one task revision and lease.
Coordinator|task.ready|coordinator_ready|Read the dependency-ready queue without claiming.
Coordinator|task.claim|coordinator_claim|Claim one ready task using current recorded revision.
Worker|task.release|coordinator_release|Release only the current matching task lease.
Worker|task.complete|coordinator_complete|Record completion of the exact leased task, not merge acceptance.
Worker|worktree.provision|worktree_provision|Provision a managed worktree for the current lease.
Observer|worktree.list|worktree_binding_list|Inspect task-worktree bindings.
Coordinator|worktree.cleanup-status|worktree_cleanup_status|Record terminal-task cleanup eligibility without deletion.
Worker|integration.create|integration_create|Create a scoped integration candidate record.
Reviewer|integration.inspect|integration_status|Read the last gate evaluation, not run it.
Reviewer|integration.list|integration_list|List integration candidates in the project.
Reviewer|integration.update|integration_update|Update candidate evidence with expected revision.
Reviewer|integration.evaluate|integration_gate|Explicitly evaluate gates and persist their result, without merging.
Operator|watchdog.scan|watchdog_scan|Explicitly reconcile alert records once, without recovery actions.
Supervisor|alert.list|watchdog_alert_list|Read stored alerts without running a scan.
Operator|alert.acknowledge|watchdog_alert_ack|Acknowledge one alert at its recorded revision.
Worker|handoff.create|handoff_create|Save an explicit checkpoint without sending a message.
Observer|handoff.list|handoff_list|List available project handoffs.
Observer|handoff.inspect|handoff_status|Inspect handoff acknowledgement and checkpoint state.
Worker|handoff.acknowledge|handoff_ack|Acknowledge receipt as the receiver session.
Observer|memory.read|project_memory_get|Read explicitly stored project memory.
Coordinator|memory.update|project_memory_update|CAS-update shared project metadata.
Supervisor|project.observe|supervisor_summary|Show the bounded read-only project overview.
Supervisor|automation.list|automation_due_list|Read due notification rows without reconciling.
Operator|automation.reconcile|automation_poll|Explicitly reconcile notification metadata, not execute work.
Operator|automation.acknowledge|automation_ack|Acknowledge the selected delivery record and consumer.
Observer|chat-goal.preflight|chat_goal_preflight|Check real host decision-channel capability.
Worker|chat-goal.create|chat_goal_create|Persist a finite current-Chat task plan without another model.
Observer|chat-goal.inspect|chat_goal_status|Read persisted Goal state in the current workspace.
Observer|chat-goal.inspect-path|chat_goal_status_by_path|Inspect Goal state at an already-authorized path.
Worker|chat-goal.claim|chat_goal_next|Claim a frozen ready task after actual channel preflight.
Worker|chat-goal.complete|chat_goal_complete|Check and checkpoint the exact completed task lease.
Worker|chat-goal.handoff|chat_goal_handoff|Save the current Chat cursor before ending the turn.
Worker|chat-goal.resume|chat_goal_resume|Resume an existing handoff after an explicit new continuation.
Worker|chat-goal.control|chat_goal_control|Pause the Goal metadata rather than a shell process.
Worker|chat-goal.ask|chat_goal_ask|Ask the human a non-sensitive business question.
Worker|card.connect|chat_goal_card_connect|Present the real short-lived card handshake.
Worker|card.wait-channel|chat_goal_card_ready|Wait once for the App channel receipt.
Worker|card.ask|chat_goal_ask_card|Present the pending non-sensitive business choice.
Worker|card.represent|chat_goal_show_decision|Re-present a pending decision on a new explicit request.
Worker|card.wait-decision|chat_goal_wait_decision|Wait once for the existing human decision.
Observer|diagnostic.view|chat_card_probe_view|Inspect a fixed diagnostic marker with no wait.
Observer|diagnostic.ping|diagnostic_ping|Read a plain transport marker and stop.
Operator|diagnostic.create|chat_card_probe_show|Create a specifically requested isolated diagnostic card.
Operator|diagnostic.wait|chat_card_probe_wait|Wait once for that diagnostic, not for arbitrary work.
Worker|desktop.observe|observe|Observe the current desktop before acting.
Worker|desktop.act|computer|Perform an explicitly requested grounded desktop action.
Worker|browser.list|browser_state|List trusted tabs without navigation.
Worker|browser.observe|browser_observe|Inspect one exact trusted browser tab.
Worker|browser.act|browser_action|Perform an explicitly requested grounded browser action.
Worker|computer-approval.show|computer_approval_show|Display the existing app-scoped approval request.
Worker|computer-approval.wait|computer_approval_wait|Wait once for the actual human approval receipt.
`.trim().split("\n").map(line => line.split("|"));
const happy: SelectionScenario[] = CASES.map(([role, intent, tool, request], index) => ({
  id: `choice-${String(index + 1).padStart(3, "0")}`, request: request!, context: { ...READY, role: role as Role, intent: intent! }, expected: [tool!],
}));
const negatives: readonly [string, string, string, Partial<RecommendationContext>][] = [
  ["read-no-workspace", "file.read", "Reading without a workspace must not silently open one.", { workspace: "none" }],
  ["patch-read-only", "file.patch", "Read-only access is not modification authority.", { workspace: "read" }],
  ["shell-read-only", "command.execute", "A read-only grant does not permit shell execution.", { workspace: "read" }],
  ["claim-no-task", "task.claim", "Do not invent a task identity when claiming.", { taskKnown: false }],
  ["claim-no-revision", "task.claim", "Inspect an unknown revision before claiming.", { revisionKnown: false }],
  ["claim-no-session", "task.claim", "A task cannot invent its worker session.", { sessionKnown: false }],
  ["release-stale-lease", "task.release", "Do not release a stale or unknown lease.", { currentTaskAuthority: false }],
  ["complete-stale-lease", "task.complete", "Do not complete a task with stale authority.", { currentTaskAuthority: false }],
  ["worktree-stale-lease", "worktree.provision", "A task label alone cannot provision a managed binding.", { currentTaskAuthority: false }],
  ["memory-stale-revision", "memory.update", "Inspect current memory revision before replacing metadata.", { revisionKnown: false }],
  ["heartbeat-no-session", "session.heartbeat", "Do not fabricate a session for a heartbeat.", { sessionKnown: false }],
  ["supervisor-no-workspace", "project.observe", "An overview still requires project scope.", { role: "Supervisor", workspace: "unknown" }],
  ["supervisor-no-scan", "watchdog.scan", "Supervisor observation must not reconcile alerts.", { role: "Supervisor" }],
  ["observer-no-claim", "task.claim", "Observer must not promote observation into a task claim.", { role: "Observer" }],
  ["reviewer-no-shell", "command.execute", "Review context does not implicitly start execution.", { role: "Reviewer" }],
  ["operator-no-merge", "integration.merge", "No merge capability exists in this catalog.", { role: "Operator" }],
  ["cleanup-no-delete", "worktree.delete", "Cleanup eligibility is not a delete command.", { role: "Coordinator" }],
  ["health-no-repair", "session.repair", "A stalled label does not create a recovery API.", { role: "Supervisor" }],
  ["shell-no-request", "command.execute", "Do not run shell commands without explicit user action.", { userRequestedAction: false }],
  ["shell-gate-pending", "command.execute", "An unresolved human gate must not be inferred approved.", { humanGate: "pending" }],
  ["desktop-stale", "desktop.act", "Stale coordinates cannot ground a desktop action.", { targetFresh: false }],
  ["browser-denied", "browser.act", "Human denial cannot become a browser action.", { humanGate: "denied" }],
  ["browser-unknown-gate", "browser.act", "Unknown approval does not mean permission.", { humanGate: "unknown" }],
  ["process-no-record", "process.interact", "Do not invent a numeric process handle.", { existingRecord: false }],
  ["chat-no-owner", "chat-goal.create", "Caller text cannot substitute for authenticated ownership.", { ownerKnown: false }],
  ["chat-no-channel", "chat-goal.claim", "A tool being listed is not a successful channel preflight.", { realHumanChannel: false }],
  ["chat-no-continuation", "chat-goal.resume", "An ended turn cannot resume itself.", { explicitUserContinuation: false }],
  ["card-no-continuation", "card.represent", "Do not automatically re-present timed-out decisions.", { explicitUserContinuation: false }],
  ["chat-complete-stale", "chat-goal.complete", "A replaced lease must not complete current work.", { currentTaskAuthority: false }],
  ["wait-no-record", "card.wait-decision", "Do not create a decision by trying to wait on it.", { existingRecord: false }],
  ["probe-not-requested", "diagnostic.create", "Do not start unsolicited interactive diagnostics.", { role: "Operator", explicitUserContinuation: false }],
  ["unknown-intent", "arbitrary.prompt.injection", "Unknown instructions must not select a near-name tool.", {}],
  ["empty-host-catalog", "file.read", "An empty actual host catalog must remain empty.", { hostToolNames: [] }],
  ["host-missing-tool", "file.read", "Do not invent a read tool when only search is listed.", { hostToolNames: ["search_files"] }],
];
const blocked: SelectionScenario[] = negatives.map(([id, intent, request, patch]) => ({ id, request, context: { ...READY, intent, ...patch }, expected: [] }));
const appOnly = ["approve_workspace_access", "chat_goal_card_status", "chat_goal_card_submit", "chat_card_probe_status", "chat_card_probe_submit", "computer_approval_submit"];
const appCases: SelectionScenario[] = appOnly.map((tool, index) => ({ id: `app-only-${index + 1}`, request: `The model must never submit or invoke ${tool}, including in the Approver role.`, context: { ...READY, role: "Approver", intent: ["access.decide", "card.synchronize", "card.decide", "diagnostic.synchronize", "diagnostic.decide", "computer-approval.decide"][index] }, expected: [] }));
const variantCases: SelectionScenario[] = [
  { id: "claude-command", request: "Use the registered Claude shell name, not the Codex alias.", context: { ...READY, intent: "command.execute", profile: { ...REVIEW_BASELINE, toolMode: "claude" } }, expected: ["bash"] },
  { id: "claude-edit", request: "Use an exact-text edit in Claude mode.", context: { ...READY, intent: "file.edit", profile: { ...REVIEW_BASELINE, toolMode: "claude" } }, expected: ["edit"] },
  { id: "claude-write", request: "Explicitly overwrite a file in Claude mode.", context: { ...READY, intent: "file.write", profile: { ...REVIEW_BASELINE, toolMode: "claude" } }, expected: ["write"] },
  { id: "linux-artifact", request: "Import the authorized host-native file on Linux.", context: { ...READY, intent: "artifact.download", profile: { ...REVIEW_BASELINE, platform: "linux", artifacts: true } }, expected: ["download_artifact"] },
  { id: "linux-no-desktop", request: "Do not invent Windows computer tools on Linux.", context: { ...READY, intent: "desktop.observe", profile: { ...REVIEW_BASELINE, platform: "linux" } }, expected: [] },
  { id: "native-start", request: "An explicitly configured native Goal can start real execution, unlike Chat Goal metadata.", context: { ...READY, intent: "native-goal.start", profile: { ...REVIEW_BASELINE, nativeGoals: true, chatGoals: false, diagnosticCards: false } }, expected: ["goal_start"] },
  { id: "native-without-grant", request: "Native startup requires durable workspace authorization.", context: { ...READY, durableGrant: false, intent: "native-goal.start", profile: { ...REVIEW_BASELINE, nativeGoals: true, chatGoals: false, diagnosticCards: false } }, expected: [] },
  { id: "ui-off-not-approval", request: "Losing App-only UI metadata must not make the model an approver.", context: { ...READY, role: "Operator", intent: "access.decide", profile: { ...REVIEW_BASELINE, ui: false, diagnosticCards: false } }, expected: [] },
];
export const SELECTION_SCENARIOS: readonly SelectionScenario[] = [...happy, ...blocked, ...appCases, ...variantCases];

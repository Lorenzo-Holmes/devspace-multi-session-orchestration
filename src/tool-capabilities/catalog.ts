import { CAPABILITIES, type Capability, type CatalogProfile, type Feature, type Role, type ToolCapability } from "./types.js";

export const SOURCE_REVISION = "5b0fefa68e0de0f544f7dd30e4d63f4f9247ed80";
/** Source-audited normalized inventory. See COLUMN_NAMES and CODE_LEGEND. */
export const COLUMN_NAMES = ["toolName", "capability", "effect", "workspace", "conditions", "idempotency", "feature", "source", "intent", "predecessors", "successors", "purpose"] as const;
export const CODE_LEGEND = {
  effect: { R: "business read; workspace cache/telemetry may change", S: "strict observation entrypoint", L: "local coordination mutation", P: "possible project mutation", X: "execution or external side effect", A: "authority/permission mutation", U: "UI lifecycle state mutation" },
  workspace: { N: "none", R: "read", M: "modify", P: "authorized-path" },
  conditions: { s: "existing project session", t: "existing project task", l: "current task authority/lease", r: "current revision", h: "human decision required", c: "human approval may be required", a: "App-only in UI-enabled baseline", o: "verified owner/record identity", k: "request-key replay contract", b: "real form/card channel", d: "durable workspace grant", f: "fresh observation/target", e: "existing record", n: "explicit new user continuation", q: "one bounded wait", p: "fresh project and separate Shrimp data root", v: "same-project scope", z: "session explicitly supplied or resolved from trusted metadata" },
  idempotency: { R: "read-again", N: "not-guaranteed", K: "same-key-same-arguments", D: "same-decision", O: "once-only", C: "compare-and-swap" },
} as const;
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  server: ["src/server.ts"], access: ["src/workspace-access-tools.ts"], codex: ["src/tool-surfaces/codex.ts"], claude: ["src/tool-surfaces/claude.ts"],
  session: ["src/orchestration-tools.ts"], coordinator: ["src/coordinator-tools.ts"], v2: ["src/orchestration-v2-tools.ts"], native: ["src/goal-tools.ts"], chat: ["src/chat-goal-tools.ts"],
  card: ["src/chat-goal-card-tools.ts"], probe: ["src/chat-card-probe.ts"], desktop: ["src/codex-cua-tools.ts", "src/windows-computer.ts"], browser: ["src/codex-cua-tools.ts"], approval: ["src/computer-use-approvals.ts"], artifact: ["src/artifact-tools.ts"],
};
/** Each line is independently reviewed against its registration and handler. */
export const INVENTORY_ROWS: readonly (readonly string[])[] = deepFreeze(`
open_workspace|workspace|P|N|c|N|base|server|workspace.open|list_workspace_access|read|Open/create or reuse an authorized checkout or create an isolated worktree; permission_required is not a grant.
read|filesystem|R|R||R|base|server|file.read|open_workspace|search_files|Read one authorized file range; reading instructions does not execute them.
list_directory|filesystem|R|R||R|base|server|directory.list|open_workspace|file_info|List bounded sorted entries without following entry symlinks.
file_info|filesystem|R|R||R|base|server|file.inspect|list_directory|read|Inspect path metadata; report final symlink objects without following them.
batch_read_files|filesystem|R|R||R|base|server|file.batch-read|search_files|read|Read up to twenty bounded text files and report per-file failures.
search_files|search|R|R||R|base|server|file.search|open_workspace|read|Search names or contents with explicit bounded filters, not shell execution.
query_sqlite|search|R|R||R|base|server|database.inspect|file_info|read|Run one row-returning read-only SQLite statement, not database mutation.
show_changes|filesystem|R|R||R|base|server|changes.review|read|read|Show combined diff once after related edits; may mark a review checkpoint locally.
devspace_runtime_info|diagnostics|S|N||R|base|server|runtime.inspect||diagnostic_ping|Read runtime identity and the current registered-name count/fingerprint; not a full-schema fingerprint.
request_workspace_access|approval|U|N|c|N|base|access|access.request|list_workspace_access|open_workspace|Request a user-visible folder decision; does not grant access by itself.
approve_workspace_access|approval|A|N|ah|O|base|access|access.decide|request_workspace_access|open_workspace|Apply the human card decision using its one-time secret and scope; never answer for the user.
list_workspace_access|workspace|S|N||R|base|access|access.list||open_workspace|List conversation-visible grants and configured roots.
revoke_workspace_access|approval|A|N||D|base|access|access.revoke|list_workspace_access|list_workspace_access|Revoke exact configured/approved path entries; broader inherited access can remain.
workspace_access_audit|diagnostics|S|N||R|base|access|access.audit|list_workspace_access|list_workspace_access|Read bounded permission audit history, not change grants.
apply_patch|filesystem|P|M||N|codex|codex|file.patch|read|show_changes|Apply explicit relative-path patch additions, edits, moves or deletions; not a shell.
exec_command|execution|X|M|c|N|codex|codex|command.execute|read|write_stdin|Run tests/builds/commands as the local user, not in a security sandbox; inspect uncertain effects before retry.
write_stdin|process|X|M|e|N|codex|codex|process.interact|exec_command|write_stdin|Poll empty chars or send input/resize/Ctrl-C to an existing numeric process session; not an orchestration session.
write|filesystem|P|M||N|claude|claude|file.write|read|show_changes|Create or fully overwrite a file; prefer exact edits for targeted modifications.
edit|filesystem|P|M||N|claude|claude|file.edit|read|show_changes|Replace unique non-overlapping exact text blocks in one file.
bash|execution|X|M||N|claude|claude|command.execute|read|show_changes|Run a local-user shell command with bounded timeout; workspace is only its initial directory.
session_register|session-observation|L|R|v|N|sessions|session|session.register|open_workspace|session_status|Register/reuse local session metadata; does not spawn or wake a worker.
session_heartbeat|session-observation|L|R|sv|N|sessions|session|session.heartbeat|session_status|session_health|Record reported activity; does not prove model liveness or keep a host request alive.
session_update|session-observation|L|R|sv|N|sessions|session|session.update|session_status|session_conflicts|Update state, label, task text or declared file intents, never the project files themselves.
session_list|session-observation|R|R|v|R|sessions|session|session.list|open_workspace|session_status|List bounded current-project sessions with derived health, not tasks.
session_status|session-observation|R|R|sv|R|sessions|session|session.inspect|session_list|session_events|Inspect one same-project session, health and declared intents.
session_events|session-observation|R|R|sv|R|sessions|session|session.events|session_status|session_health|Read bounded recorded events; a test_run event alone is not verified evidence.
session_health|session-observation|R|R|sv|R|sessions|session|session.health|session_status|session_events|Derive observational health without retries, process control or liveness certification.
session_conflicts|session-observation|R|R|v|R|sessions|session|session.conflicts|session_list|session_status|Inspect bounded declared-intent overlaps; empty does not certify a complete scan.
coordinator_plan_create|coordination|L|R|v|N|coordinator|coordinator|plan.create|open_workspace|coordinator_task_list|Persist a project-scoped task DAG without executing tasks or spawning workers.
coordinator_task_list|coordination|R|R|v|R|coordinator|coordinator|task.list|open_workspace|coordinator_task_status|List durable project tasks, not registered sessions.
coordinator_task_status|coordination|R|R|tv|R|coordinator|coordinator|task.inspect|coordinator_task_list|coordinator_ready|Read one scoped task and its current revision/lease state.
coordinator_ready|coordination|R|R|v|R|coordinator|coordinator|task.ready|coordinator_task_list|coordinator_task_status|Read the derived dependency-ready queue without claiming anything.
coordinator_claim|coordination|L|R|tzrv|C|coordinator|coordinator|task.claim|coordinator_ready,coordinator_task_status|worktree_provision|Claim a ready task with current revision and a resolved same-project session; no execution.
coordinator_release|coordination|L|R|tzlrv|C|coordinator|coordinator|task.release|coordinator_task_status|coordinator_ready|Release the matching current fenced lease; stale ownership is not permission to release.
coordinator_complete|coordination|L|R|tzlrv|C|coordinator|coordinator|task.complete|coordinator_task_status|integration_status|Mark the matching leased task complete; this is not merge or test acceptance.
worktree_provision|worktree|P|M|stlrv|C|v2|v2|worktree.provision|coordinator_claim,coordinator_task_status|worktree_binding_list|Provision a managed isolated worktree with current task authority; no reset, clean, stash, merge or deletion.
worktree_binding_list|worktree|R|R|v|R|v2|v2|worktree.list|open_workspace|coordinator_task_status|List bounded managed task/worktree bindings in project scope.
worktree_cleanup_status|worktree|L|R|trv|C|v2|v2|worktree.cleanup-status|coordinator_task_status|worktree_binding_list|Persist cleanup eligibility for a terminal task; never delete its worktree.
integration_create|integration|L|R|stv|N|v2|v2|integration.create|coordinator_task_status|integration_status|Create a review candidate record bound to the scoped task and session; does not merge.
integration_status|integration|R|R|ev|R|v2|v2|integration.inspect|integration_list|session_events|Read the stored gate snapshot and last checkedAt, not recompute it or grant merge permission.
integration_list|integration|R|R|v|R|v2|v2|integration.list|open_workspace|integration_status|List bounded integration candidates in project scope.
integration_update|integration|L|R|erv|C|v2|v2|integration.update|integration_status,session_events|integration_status|CAS-update review/evidence metadata and invalidate old gate results.
integration_gate|integration|L|R|erv|C|v2|v2|integration.evaluate|integration_status|integration_status|Evaluate current Git/evidence gates and persist a snapshot; missing evidence can fail gates, and success never authorizes merge.
watchdog_scan|watchdog|L|R|v|N|v2|v2|watchdog.scan|supervisor_summary|watchdog_alert_list|Compute and persist alert reconciliation once; not background monitoring or automatic repair.
watchdog_alert_list|watchdog|R|R|v|R|v2|v2|alert.list|supervisor_summary|session_status|Read stored bounded alerts without scanning or acknowledging them.
watchdog_alert_ack|watchdog|L|R|erv|C|v2|v2|alert.acknowledge|watchdog_alert_list|watchdog_alert_list|Acknowledge one alert at its expected revision without repairing its cause.
handoff_create|handoff|L|R|sv|N|v2|v2|handoff.create|session_status|handoff_status|Persist an explicit checkpoint for another session; does not send messages or transfer execution authority.
handoff_list|handoff|R|R|v|R|v2|v2|handoff.list|open_workspace|handoff_status|Read bounded project handoff checkpoints.
handoff_status|handoff|R|R|ev|R|v2|v2|handoff.inspect|handoff_list|session_status|Read one scoped handoff and its acknowledgement state.
handoff_ack|handoff|L|R|serv|C|v2|v2|handoff.acknowledge|handoff_status|handoff_status|Record receiver-session acknowledgement with current revision; no messages or task claim.
project_memory_get|project-memory|R|R|v|R|v2|v2|memory.read|open_workspace|session_status|Read explicit shared project memory; a missing revision zero does not create a record.
project_memory_update|project-memory|L|R|rv|C|v2|v2|memory.update|project_memory_get|project_memory_get|CAS-update explicit project metadata, not implicit model memory or project files.
supervisor_summary|supervisor|S|R|v|R|v2|v2|project.observe|open_workspace|session_status,integration_status,watchdog_alert_list|Read one bounded project observation; no claim, release, retry, merge, kill, spawn, delete or approval.
automation_due_list|automation|R|R|v|R|v2|v2|automation.list|open_workspace|supervisor_summary|List due notifications without reconciliation; continue nextCursor even after an empty filtered page.
automation_poll|automation|L|R|v|N|v2|v2|automation.reconcile|automation_due_list|automation_due_list|Reconcile bounded notification metadata for an external scheduler, not execute tasks or models.
automation_ack|automation|L|R|erv|C|v2|v2|automation.acknowledge|automation_due_list|automation_due_list|Acknowledge a notification with revision and consumer identity; never infer delivery success from discovery.
goal_start|goal-control|X|M|odk|K|native-goals|native|native-goal.start|list_workspace_access|goal_status|Start a real native desktop Goal in a dedicated empty durably authorized workspace using the local account.
goal_status|goal-control|R|N|oe|R|native-goals|native|native-goal.inspect|goal_list|goal_list|Read real native Goal state, cached-runtime qualifications and artifact checkpoints.
goal_list|goal-control|R|N|o|R|native-goals|native|native-goal.list||goal_status|Recover owned native Goals in durably authorized projects across conversations.
goal_pause|goal-control|X|N|oerk|K|native-goals|native|native-goal.pause|goal_status|goal_status|Request native pause; read status for acknowledgement rather than assuming execution stopped.
goal_resume|goal-control|X|N|oerk|K|native-goals|native|native-goal.resume|goal_status|goal_status|Resume the same confirmed paused native Goal; no recreation or budget increase.
goal_stop|goal-control|X|N|oerk|K|native-goals|native|native-goal.stop|goal_status|goal_status|Request terminal native stop while preserving files/history; status must acknowledge it.
chat_goal_preflight|goal-control|S|N|o|R|chat-goals|chat|chat-goal.preflight||chat_goal_card_connect|Check real host form/card capability before creation or claim; grants neither permissions nor quota.
chat_goal_create|goal-control|P|M|obkp|K|chat-goals|chat|chat-goal.create|chat_goal_preflight|chat_goal_status|Initialize project Git and persist finite frozen tasks in separate Shrimp data; no native/API/local model spawning.
chat_goal_status|goal-control|R|M|o|R|chat-goals|chat|chat-goal.inspect|open_workspace|chat_goal_next|Read persisted workspace Goals and durable recovery state; task leases do not imply model liveness.
chat_goal_status_by_path|goal-control|S|P|o|R|chat-goals|chat|chat-goal.inspect-path|list_workspace_access|chat_goal_status|Read Goal state from an already-authorized path without opening a workspace or requesting stronger access.
chat_goal_next|goal-control|L|M|oerbk|K|chat-goals|chat|chat-goal.claim|chat_goal_status,chat_goal_preflight|chat_goal_complete|Claim/renew one frozen ready local task after real channel preflight; no execution or filesystem authorization.
chat_goal_complete|goal-control|P|M|otlrk|K|chat-goals|chat|chat-goal.complete|chat_goal_status|chat_goal_status|Assess frozen acceptance checks and record real artifact/Git checkpoints for the exact lease; not independent semantic grading.
chat_goal_handoff|goal-control|L|M|oerk|K|chat-goals|chat|chat-goal.handoff|chat_goal_status|chat_goal_status|Save a cursor before ending an unfinished turn; does not wake a future turn or renew a task lease.
chat_goal_resume|goal-control|L|M|oerbnk|K|chat-goals|chat|chat-goal.resume|chat_goal_status,chat_goal_preflight|chat_goal_next|Resume the exact live handoff only after a new explicit user continuation and real channel preflight.
chat_goal_control|goal-control|L|M|oerk|K|chat-goals|chat|chat-goal.control|chat_goal_status|chat_goal_status|Pause/resume/stop coordination, not a generic shell process or an ended Chat request.
chat_goal_ask|goal-control|U|M|oerkh|N|chat-goals|chat|chat-goal.ask|chat_goal_status|chat_goal_status|Persist a non-sensitive business choice and request a bounded host form; never request credentials or permissions.
chat_goal_card_connect|goal-control|U|N|ok|K|goal-cards|card|card.connect|chat_goal_preflight|chat_goal_card_ready|Present a real short-lived card channel handshake, not human approval or a Goal.
chat_goal_card_ready|goal-control|U|N|oeq|O|goal-cards|card|card.wait-channel|chat_goal_card_connect|chat_goal_preflight|Wait once at most 45 seconds for the app receipt; receipt is not a live/current Chat proof.
chat_goal_ask_card|goal-control|U|M|oerbk h|K|goal-cards|card|card.ask|chat_goal_status|chat_goal_wait_decision|Present a non-sensitive pending business decision; never answer for the human.
chat_goal_show_decision|goal-control|U|M|oebn|N|goal-cards|card|card.represent|chat_goal_status|chat_goal_wait_decision|Re-present the same pending choice only on an explicit new request; invalidate old cards without extending waits automatically.
chat_goal_wait_decision|goal-control|U|N|oeq|O|goal-cards|card|card.wait-decision|chat_goal_ask_card|chat_goal_status|Wait once within the active request; timeout/disconnect means stop, not poll or wake another turn.
chat_goal_card_status|goal-control|U|N|aoe|D|goal-cards|card|card.synchronize|chat_goal_card_connect|chat_goal_card_ready|App-only secret-protected acknowledgement/status; does not extend deadlines or grant access.
chat_goal_card_submit|goal-control|U|N|aoeh|D|goal-cards|card|card.decide|chat_goal_ask_card|chat_goal_status|App-only secret-protected human business choice or cancellation, never filesystem/process approval.
chat_card_probe_view|diagnostics|S|N|o|R|diagnostic-cards|probe|diagnostic.view||diagnostic_ping|Show a fixed read-only transport marker with no probe, token, wait or approval.
diagnostic_ping|diagnostics|S|N|o|R|diagnostic-cards|probe|diagnostic.ping||chat_card_probe_view|Read the fixed transport marker without UI and stop.
chat_card_probe_show|diagnostics|U|N|okn|K|diagnostic-cards|probe|diagnostic.create||chat_card_probe_wait|Create an isolated user-requested diagnostic; reuse keys only for the same uncertain call.
chat_card_probe_wait|diagnostics|U|N|oeq|O|diagnostic-cards|probe|diagnostic.wait|chat_card_probe_show|diagnostic_ping|One bounded wait only; not a heartbeat, model-resume API or automatic follow-up.
chat_card_probe_status|diagnostics|U|N|aoe|N|diagnostic-cards|probe|diagnostic.synchronize|chat_card_probe_show|diagnostic_ping|App-only token-protected status increments bounded diagnostic counters despite the readOnlyHint annotation.
chat_card_probe_submit|diagnostics|U|N|aoeh|D|diagnostic-cards|probe|diagnostic.decide|chat_card_probe_show|diagnostic_ping|App-only diagnostic receipt; never permission or Goal acceptance.
observe|computer-use|R|R|cf|R|desktop|desktop|desktop.observe|open_workspace|computer|Observe exact desktop targets; CUA and legacy schemas differ, and CUA can preserve human app approval.
computer|computer-use|X|M|cf|N|desktop|desktop|desktop.act|observe|observe|Act once on a fresh exact desktop target; workspace directories do not contain GUI effects.
browser_state|browser-use|R|R|c|R|browser|browser|browser.list|open_workspace|browser_observe|List trusted browser sessions/tabs through CUA with real turn metadata; does not navigate.
browser_observe|browser-use|R|R|cf|R|browser|browser|browser.observe|browser_state|browser_action|Read an exact trusted browser tab and current URL with origin checks and approvals retained.
browser_action|browser-use|X|M|cf|N|browser|browser|browser.act|browser_observe|browser_observe|Perform one bounded browser action then observe; retain trusted origin and human confirmation checks.
computer_approval_show|approval|R|R|oe|R|computer-approval|approval|computer-approval.show|observe|computer_approval_wait|Show an existing CUA permission request; does not create or approve it for the user.
computer_approval_wait|approval|U|R|oeq|O|computer-approval|approval|computer-approval.wait|computer_approval_show|observe|Wait once for the real human choice; only the returned retry action permits retrying the original call.
computer_approval_submit|approval|A|N|aoeh|D|computer-approval|approval|computer-approval.decide|computer_approval_show|observe|App-only secret-protected choice bound to OAuth client, workspace and app/origin; not a permanent OS setting.
download_artifact|filesystem|P|M|e|N|artifact|artifact|artifact.download|open_workspace|file_info|Stream a host-native authorized file into a new relative destination; Linux-only, no overwrite or arbitrary URL.
`.trim().split("\n").map(line => line.split("|")));

const conditionText: Readonly<Record<string, string>> = {
  s: "requiresSameProjectSession", t: "requiresExistingProjectTask", l: "requiresCurrentTaskAuthority", r: "requiresCurrentRecordRevision", h: "requiresHumanDecisionNotModelAnswer", c: "preserveApplicableHumanApproval", a: "neverRecommendAppOnlyToModel", o: "requiresVerifiedOwnerOrClientRecordIdentity", k: "reuseExactRequestKeyAndArgumentsAfterUncertainReply", b: "requiresRealHostFormOrAcknowledgedCardChannel", d: "requiresDurableWorkspaceGrant", f: "requiresFreshTrustedTargetBeforeAction", e: "requiresExistingRecordOrHostNativeArtifact", n: "requiresExplicitUserContinuationOrDiagnosticRequest", q: "boundedWaitOnceNoAutomaticExtension", p: "requiresFreshProjectAndSeparateDataRoot", v: "requiresServerDerivedProjectScope", z: "requiresExplicitOrTrustedResolvedSession",
};
const observerCapabilities: readonly Capability[] = ["workspace", "filesystem", "search", "session-observation", "coordination", "worktree", "integration", "watchdog", "handoff", "project-memory", "supervisor", "diagnostics", "automation"];
function rolesFor(capability: Capability, name: string, read: boolean): Role[] {
  const roles: Role[] = [];
  if (read && (observerCapabilities.includes(capability) || capability === "goal-control" || capability === "approval")) roles.push("Observer");
  if (["workspace", "filesystem", "search", "session-observation", "coordination", "worktree", "handoff", "project-memory", "supervisor"].includes(capability)) roles.push("Worker");
  if (["session-observation", "coordination", "worktree", "handoff", "project-memory", "supervisor", "automation"].includes(capability) || (read && capability === "integration")) roles.push("Coordinator");
  if (["filesystem", "search", "integration", "supervisor"].includes(capability) || (read && ["coordination", "worktree", "session-observation"].includes(capability))) roles.push("Reviewer");
  if (read && ["session-observation", "coordination", "worktree", "integration", "watchdog", "handoff", "project-memory", "supervisor", "automation"].includes(capability)) roles.push("Supervisor");
  if (read && ["approval", "workspace", "diagnostics"].includes(capability)) roles.push("Approver");
  if (["diagnostics", "workspace", "approval", "watchdog", "automation", "supervisor"].includes(capability)) roles.push("Operator");
  if (["execution", "process", "computer-use", "browser-use", "goal-control"].includes(capability)) roles.push("Worker", "Operator");
  if (["integration_create", "integration_update", "request_workspace_access", "computer_approval_show", "computer_approval_wait"].includes(name)) roles.push("Worker");
  return [...new Set(roles)];
}
function decode(row: readonly string[]): ToolCapability {
  if (row.length !== COLUMN_NAMES.length) throw new Error(`Invalid catalog row ${row[0]}`);
  const [name = "", cap = "", effect = "", workspace = "", flags = "", idem = "", feature = "", source = "", intent = "", before = "", after = "", purpose = ""] = row;
  if (!CAPABILITIES.includes(cap as Capability) || !SOURCES[source] || !Object.hasOwn(CODE_LEGEND.effect, effect) || !Object.hasOwn(CODE_LEGEND.workspace, workspace) || !Object.hasOwn(CODE_LEGEND.idempotency, idem)) throw new Error(`Unclassified tool ${name}`);
  const read = effect === "R" || effect === "S";
  const project = ["P", "X"].includes(effect);
  const appOnly = flags.includes("a");
  const constraints = [
    ...(read ? ["businessReadOnly"] : []),
    ...(["L", "U"].includes(effect) ? ["metadataOnly", "doesNotGrantFilesystemAccess"] : []),
    ...(effect !== "X" ? ["doesNotSpawnModel", "doesNotMerge"] : []),
    ...(["session-observation", "supervisor", "automation"].includes(cap) ? ["doesNotProveLiveness"] : []),
    ...(cap === "worktree" ? ["doesNotDeleteWorktree", "worktreeIsNotSandbox"] : []),
    ...(["execution", "process"].includes(cap) ? ["shellIsNotSandbox", "inspectBeforeRetry"] : []),
    ...(flags.includes("h") ? ["requiresHumanApproval"] : []),
    ...(appOnly ? ["hiddenToolIsNotAuthorization", "modelMustNotSubmit"] : []),
    ...(name.startsWith("chat_goal_") ? ["doesNotWakeChatTurn"] : []),
  ];
  return {
    toolName: name, namespace: intent.split(".")[0]!, capability: cap as Capability, purpose, intent,
    mutability: read ? "read" : "mutate", projectMutation: project ? "possible" : "none",
    localStateMutation: effect === "S" ? "none" : read ? "incidental" : "yes",
    externalSideEffect: effect === "X" || name === "download_artifact" ? "possible" : "none",
    risk: ["X", "A"].includes(effect) ? "high" : read ? "low" : "medium",
    prerequisites: {
      workspace: ({ N: "none", R: "read", M: "modify", P: "authorized-path" } as const)[workspace as keyof typeof CODE_LEGEND.workspace],
      session: flags.includes("s") ? "required" : flags.includes("z") ? "resolved" : "none",
      task: flags.includes("t") ? "required" : "none", lease: flags.includes("l") ? "required" : name === "chat_goal_next" ? "conditional" : "none",
      revision: flags.includes("r") ? "required" : "none", humanApproval: flags.includes("h") ? "required" : flags.includes("c") ? "conditional" : "none",
      requiresCurrentTaskAuthority: flags.includes("l"), conditions: [...new Set(flags.replaceAll(" ", ""))].map(key => conditionText[key] ?? (() => { throw new Error(`Unknown condition ${key}`); })()),
    },
    visibility: appOnly ? "app-only" : "model-visible",
    visibilityWithoutUi: name === "approve_workspace_access" ? "model-visible" : ["goal-cards", "diagnostic-cards", "computer-approval"].includes(feature) ? "absent" : "model-visible",
    feature: feature as Feature, sourceFiles: [...SOURCES[source]!],
    idempotency: (CODE_LEGEND.idempotency as Record<string, ToolCapability["idempotency"]>)[idem] ?? "not-guaranteed",
    sideEffects: [...(project ? ["project-files-or-worktree"] : []), ...(!read ? ["local-state"] : effect === "R" ? ["possible-cache-telemetry-or-review-bookkeeping"] : []), ...(effect === "X" ? ["local-process-or-external-account"] : []), ...(effect === "A" ? ["permission-state"] : []), ...(effect === "U" ? ["host-ui-lifecycle"] : []), ...(name === "download_artifact" ? ["network-download"] : [])],
    constraints, typicalPredecessors: before ? before.split(",") : [], typicalSuccessors: after ? after.split(",") : [],
    recommendedRoles: appOnly ? [] : rolesFor(cap as Capability, name, read),
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
/** Frozen data; zero registration, filesystem, database, clock or network imports. */
export const TOOL_CAPABILITIES: readonly ToolCapability[] = deepFreeze(INVENTORY_ROWS.map(decode).sort((a, b) => a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));
export const REVIEW_BASELINE: Readonly<CatalogProfile> = Object.freeze({ platform: "win32", toolMode: "codex", ui: true, sessions: true, coordinator: true, v2: true, nativeGoals: false, chatGoals: true, diagnosticCards: true, computerUse: true, cuaBridge: true, artifacts: false });
export function catalogForProfile(profile: Readonly<CatalogProfile>): readonly ToolCapability[] {
  if (profile.nativeGoals && profile.chatGoals) throw new Error("Native and Chat Goals cannot both be enabled");
  if (profile.diagnosticCards && (!profile.ui || profile.nativeGoals)) throw new Error("Diagnostic cards require UI and native Goals disabled");
  const active: Record<Feature, boolean> = {
    base: true, codex: profile.toolMode === "codex", claude: profile.toolMode === "claude", sessions: profile.sessions,
    coordinator: profile.coordinator && profile.sessions, v2: profile.v2, "native-goals": profile.nativeGoals, "chat-goals": profile.chatGoals,
    "goal-cards": profile.chatGoals && profile.ui, "diagnostic-cards": profile.diagnosticCards,
    desktop: profile.computerUse && profile.platform === "win32", browser: profile.computerUse && profile.cuaBridge && profile.platform === "win32",
    "computer-approval": profile.computerUse && profile.cuaBridge && profile.ui && profile.platform === "win32", artifact: profile.artifacts && profile.platform === "linux",
  };
  return TOOL_CAPABILITIES.filter(tool => active[tool.feature]).map(tool => profile.ui || tool.visibility !== "app-only" ? tool : { ...tool, visibility: tool.visibilityWithoutUi === "model-visible" ? "model-visible" as const : "app-only" as const });
}
/** Normalized JSON is a lossless machine-readable inventory; decoded records are the public TS API. */
export function inventoryDocument(): object { return { schemaVersion: 1, sourceRevision: SOURCE_REVISION, columns: COLUMN_NAMES, legend: CODE_LEGEND, rows: INVENTORY_ROWS, sources: SOURCES }; }

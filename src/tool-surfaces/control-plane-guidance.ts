/** Additive human/model guidance only; no protocol annotations or runtime authorization. */
export const CONTROL_PLANE_GUIDANCE = [
  "Control-plane guidance (advisory, not authorization): use only tools actually present in the current host catalog.",
  "Inspect files with native read/search tools before shell execution. A workspace or worktree is not a shell, desktop or browser security sandbox.",
  "Use session_status/session_events for recorded session activity, coordinator_task_status for task revision/lease ownership, and supervisor_summary for a bounded read-only overview when those tools are present.",
  "A heartbeat is not model liveness. A test_run event alone is not verified test evidence. Empty or truncated observations do not establish absence.",
  "integration_status reads a past evaluation; integration_gate writes an evaluation snapshot. Neither authorizes merging. Inspect current evidence and revision before any explicit mutation.",
  "coordinator_claim grants a task lease, not model execution or filesystem access. worktree_cleanup_status records eligibility; it does not delete a worktree.",
  "Never submit App-only approvals or answer for a human. Hidden tools and role recommendations are not authorization; retain every server-side identity, grant, token and freshness check.",
  "Do not infer retries, claims, releases, merges, process control or automatic continuation from health labels. Inspect an uncertain write outcome before retrying. Bounded waits cannot keep an ended Chat turn alive.",
].join("\n");

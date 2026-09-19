/** Observation-only adapter. No store, manager, transport, clock, or model dependency. */
export const SECTION_ORDER = ["needsAttention", "sessions", "tasks", "integrations", "alerts", "bindings", "conflicts", "handoffs", "readyTasks", "claimedTasks", "blockedTasks"] as const;
export type SectionKey = typeof SECTION_ORDER[number];
export type TrustLevel = "Observed" | "Derived" | "Verified" | "Stale" | "Unknown";
export type Completeness = "complete" | "incomplete" | "unknown";
export interface SnapshotItem {
  id: string; title: string; state: string; detail: string;
  timeline: { at: string; kind: string; detail: string }[];
}
export interface Snapshot {
  schemaVersion: 1; project: string; generatedAt: string; truncated: boolean;
  counts: { active: number; idle: number; stalled: number; blocked: number; readyReview: number; conflicts: number; alerts: number; completed: number };
  sections: { key: SectionKey; title: string; total: number; items: SnapshotItem[] }[];
}
/** Future adapters may supply structured evidence. Presence never upgrades trust to Verified. */
export interface ObservationExtension {
  source?: string; observedAt?: string; checkedAt?: string;
  revision?: string | number; generation?: string | number;
  logicalSession?: string; incarnation?: string; attempt?: string; evidence?: string;
  deliveryEpisode?: string; workspace?: string; filesTouched?: string;
}
export interface PresentationContext {
  nowMs: number;
  extensions?: Readonly<Record<string, ObservationExtension>>;
  // Only a future audited backend adapter may establish these, not an untrusted card payload.
  completeness?: { data?: Completeness; input?: Completeness };
}
export interface ObservationRow {
  id: string; title: string; state: string; detail: string; source: string;
  trust: TrustLevel; age: string; severity: "warning" | "info";
  nextInspection: string; facts: string[];
  timeline: TimelineRow[];
}
export interface TimelineRow {
  at: string; source: string; subject: string; kind: string; summary: string; trust: TrustLevel;
}
export interface Presentation {
  project: string; snapshotAt: string; snapshotAge: string;
  stale: boolean; clockUnknown: boolean; dataComplete: Completeness; inputComplete: Completeness;
  truncated: boolean; trust: TrustLevel; source: string;
  counts: Snapshot["counts"];
  sections: { key: SectionKey; title: string; total: number; received: number; rows: ObservationRow[] }[];
  timeline: TimelineRow[];
}
export const PRESENTATION_LIMITS = Object.freeze({ sections: 11, rowsPerSection: 8, eventsPerRow: 3, timeline: 40, text: 240, staleAfterMs: 300_000, htmlBytes: 131_072 });

/** Bound before Unicode iteration; strip directional/control overrides, preserve natural RTL letters. */
export function displayText(value: unknown, max: number = PRESENTATION_LIMITS.text): string {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "Unknown";
  const bound = Number.isFinite(max) ? Math.max(1, Math.min(1000, Math.trunc(max))) : PRESENTATION_LIMITS.text;
  const clean = text.slice(0, bound * 2 + 2).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
  const chars = Array.from(clean);
  return chars.length > bound || text.length > bound * 2 + 2 ? chars.slice(0, bound - 1).join("") + "\u2026" : clean;
}
export function snapshotFreshness(at: string | undefined, nowMs: number): { age: string; stale: boolean; unknown: boolean } {
  const time = typeof at === "string" ? Date.parse(at) : NaN;
  const elapsed = nowMs - time;
  if (!Number.isFinite(time) || !Number.isFinite(nowMs) || elapsed < 0) return { age: "Unknown (missing timestamp or clock skew)", stale: false, unknown: true };
  return { age: elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : `${Math.floor(elapsed / 60_000)}m`, stale: elapsed > PRESENTATION_LIMITS.staleAfterMs, unknown: false };
}
const finiteCount = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const labelState = (state: string) => state === "merge_ready" ? "Gate conditions met at last evaluation; NOT merge authority" : state === "ready_review" ? "Ready for review (reported)" : displayText(state, 100);
function nextInspection(key: SectionKey, row: SnapshotItem): string {
  if (key === "integrations") return "integration_status: inspect last evaluation and evidence; no merge is authorized here";
  if (key === "bindings") return "worktree_binding_list: inspect binding and task status; do not delete";
  if (key === "handoffs") return "handoff_status: inspect checkpoint and receiver context";
  if (key === "conflicts") return "session_conflicts: inspect reported overlap; completeness may be unknown";
  if (key === "alerts") return "watchdog_alert_list: inspect persisted signal; no repair is performed";
  if (/lease|task/i.test(row.title + " " + row.state) || /Tasks$/.test(key) || key === "tasks") return "coordinator_task_status: inspect task authority, revision and lease";
  if (/unverified|test/i.test(row.title + " " + row.state)) return "session_events: inspect recorded test evidence; an event is not verified success";
  return "session_status / session_events: inspect recorded state and last activity, not model liveness";
}
const extensionKey = (key: SectionKey, id: string) => `${key}:${id}`;
export function presentSupervisor(s: Snapshot, context: PresentationContext): Presentation {
  const fresh = snapshotFreshness(s.generatedAt, context.nowMs);
  const trust: TrustLevel = fresh.unknown ? "Unknown" : fresh.stale ? "Stale" : "Observed";
  const dataComplete = context.completeness?.data ?? "unknown";
  const inputComplete = context.completeness?.input ?? "unknown";
  const sections = SECTION_ORDER.map(key => s.sections.slice(0, PRESENTATION_LIMITS.sections).find(section => section.key === key)).filter(section => section !== undefined).map(section => {
    const rows = section.items.slice(0, PRESENTATION_LIMITS.rowsPerSection).map(row => {
      const ext = context.extensions?.[extensionKey(section.key, row.id)];
      const rowTime = ext?.observedAt;
      const age = snapshotFreshness(rowTime, context.nowMs);
      const base: TrustLevel = section.key === "integrations" ? "Unknown" : ["sessions", "needsAttention", "conflicts", "readyTasks", "blockedTasks"].includes(section.key) ? "Derived" : "Observed";
      const rowTrust: TrustLevel = fresh.stale || age.stale ? "Stale" : fresh.unknown ? "Unknown" : base;
      const facts = (["revision", "generation", "logicalSession", "incarnation", "attempt", "evidence", "deliveryEpisode", "workspace", "filesTouched"] as const)
        .filter(name => ext?.[name] !== undefined).slice(0, 6).map(name => `${name} (reported): ${displayText(ext![name], 80)}`);
      if (section.key === "integrations") facts.unshift(ext?.checkedAt ? `Last evaluated at ${displayText(ext.checkedAt, 80)}; freshness must be checked against current state` : "Last evaluated at: see source detail; structured freshness is Unknown");
      const source = displayText(ext?.source ?? `supervisor_summary/v1:${section.key}`, 100);
      return {
        id: displayText(row.id, 100), title: displayText(row.title, 120), state: labelState(row.state), detail: displayText(row.detail), source,
        trust: rowTrust, age: age.age, severity: section.key === "needsAttention" || section.key === "alerts" ? "warning" as const : "info" as const,
        nextInspection: nextInspection(section.key, row), facts,
        timeline: row.timeline.slice(0, PRESENTATION_LIMITS.eventsPerRow).map(event => {
          const ef = snapshotFreshness(event.at, context.nowMs);
          return { at: displayText(event.at, 80), source, subject: displayText(row.title, 80), kind: displayText(event.kind, 60), summary: displayText(event.detail, 160), trust: ef.unknown ? "Unknown" as const : ef.stale ? "Stale" as const : section.key === "tasks" ? "Derived" as const : "Observed" as const };
        }),
      };
    });
    return { key: section.key, title: displayText(section.title, 120), total: finiteCount(section.total), received: Math.min(section.items.length, 50), rows };
  });
  const timeline = sections.flatMap(section => section.rows.flatMap(row => row.timeline));
  // Explicit tie breakers make order independent of locale. Do not infer transitions from snapshots.
  timeline.sort((a, b) => {
    const delta = (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
    if (delta) return delta;
    const ak = a.source + a.subject + a.kind, bk = b.source + b.subject + b.kind;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const countKeys = ["active", "idle", "stalled", "blocked", "readyReview", "conflicts", "alerts", "completed"] as const;
  const counts = Object.fromEntries(countKeys.map(key => [key, finiteCount(s.counts[key])])) as Snapshot["counts"];
  return { project: displayText(s.project), snapshotAt: displayText(s.generatedAt, 80), snapshotAge: fresh.age, stale: fresh.stale, clockUnknown: fresh.unknown,
    dataComplete, inputComplete, truncated: s.truncated || sections.some(x => x.total > x.rows.length || x.received > x.rows.length) || timeline.length > PRESENTATION_LIMITS.timeline,
    trust, source: "supervisor_summary/v1 (bounded observation)", counts, sections, timeline: timeline.slice(0, PRESENTATION_LIMITS.timeline) };
}

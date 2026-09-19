import { PRESENTATION_LIMITS, presentSupervisor, type Presentation, type PresentationContext, type Snapshot } from "./model.js";
const escape = (value: string | number) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const labels = { active: "Active", idle: "Idle", stalled: "Stalled", blocked: "Blocked", readyReview: "Ready Review", conflicts: "Conflicts", alerts: "Alerts", completed: "Completed" } as const;
const text = (value: string | number) => `<bdi>${escape(value)}</bdi>`;
function html(p: Presentation, clipped: boolean): string {
  return `<header><p class="eyebrow">DEVSPACE / SUPERVISOR / READ ONLY</p><h1>Project observation</h1><p class="project">${text(p.project)}</p><p class="meta">Snapshot at ${text(p.snapshotAt)} | Age at render: ${text(p.snapshotAge)} | ${p.trust}</p><p class="meta">Source: ${p.source}</p></header>
<div class="notice" role="note"><strong>Completeness ${p.dataComplete === "unknown" ? "unknown" : p.dataComplete}</strong> | Input ${p.inputComplete} | ${p.truncated || clipped ? "Truncated / display limited" : "No reported display truncation (not proof of completeness)"}. Counts describe bounded input, not a complete project scan. Empty output does not prove absence.</div>
<div class="metrics">${Object.entries(p.counts).map(([key, value]) => `<article class="metric ${key}"><span>${labels[key as keyof typeof labels]}</span><strong>${value}</strong><small>in received snapshot</small></article>`).join("")}</div>
<p class="notice">Observed activity and heartbeats do not prove a worker or model is alive. Derived health is not execution authority. Test events are not Verified evidence. Integration results describe a past evaluation, not merge permission. Refresh only through an explicit observation tool call.</p>
<div class="sections">${p.sections.map(section => `<section><h2>${text(section.title)}</h2><p class="meta">${section.rows.length} of ${section.total} snapshot rows shown; ${section.received} received. Project completeness unknown.</p>${section.rows.length ? section.rows.map(row => `<details><summary><span>${text(row.title)}</span><em>${text(row.state)}</em></summary><p>${text(row.detail)}</p><p class="meta">${row.trust} | Severity: ${row.severity} | Source: ${text(row.source)} | Event age: ${text(row.age)}</p>${row.facts.map(fact => `<p class="meta">${text(fact)}</p>`).join("")}<p class="inspection">Next inspection (advice only): ${text(row.nextInspection)}</p>${row.timeline.length ? `<ol>${row.timeline.map(event => `<li><time>${text(event.at)}</time> ${text(event.kind)} <small>${event.trust}</small><p>${text(event.summary)}</p></li>`).join("")}</ol><p class="meta">Up to ${PRESENTATION_LIMITS.eventsPerRow} events displayed per row; backend may supply only 10. Not a complete audit log.</p>` : '<p class="empty">No timeline supplied; history unknown.</p>'}</details>`).join("") : '<p class="empty">No records in this bounded snapshot. Completeness unknown.</p>'}</section>`).join("")}</div>
<section class="timeline"><h2>Timeline / bounded observations</h2><p class="meta">${p.timeline.length} shown; maximum ${PRESENTATION_LIMITS.timeline}. Task rows may be current-state snapshots, not a transition history.</p><ol>${p.timeline.map(event => `<li><time>${text(event.at)}</time> ${text(event.subject)} | ${text(event.kind)} | ${event.trust}<p>${text(event.summary)}</p><small>${text(event.source)}</small></li>`).join("")}</ol></section>
<p class="notice">Workspace, files touched, structured test evidence, automation deliveries and runtime/build provenance may be absent from v1: Unknown, not zero. Inspect the corresponding read tools. This card cannot claim, release, retry, merge, kill, spawn, delete or approve.</p>${clipped ? '<p class="notice">HTML display byte budget reached; inspect the source list tools for omitted rows.</p>' : ""}`;
}
/** Only escaped text enters HTML. The fixed wrapper and bounded model contain no actions. */
export function renderSupervisorPresentation(snapshot: Snapshot, context: PresentationContext): string {
  const p = presentSupervisor(snapshot, context);
  const encoder = new TextEncoder();
  let clipped = false, output = html(p, clipped);
  while (encoder.encode(output).byteLength > PRESENTATION_LIMITS.htmlBytes) {
    clipped = true;
    if (p.timeline.length) p.timeline.pop();
    else {
      const largest = [...p.sections].sort((a, b) => b.rows.length - a.rows.length)[0];
      if (!largest?.rows.length) throw new Error("Fixed supervisor layout exceeds byte budget");
      largest.rows.pop();
    }
    output = html(p, clipped);
  }
  return output;
}

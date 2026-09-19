import assert from "node:assert/strict";
import test from "node:test";
import { presentSupervisor, SECTION_ORDER, snapshotFreshness, type Snapshot, type ObservationExtension, PRESENTATION_LIMITS } from "./model.js";
import { renderSupervisorPresentation } from "./render.js";
const NOW = Date.parse("2026-09-19T12:00:00Z");
function snapshot(): Snapshot {
  return { schemaVersion: 1, project: "p", generatedAt: new Date(NOW).toISOString(), truncated: false,
    counts: { active: 0, idle: 0, stalled: 0, blocked: 0, readyReview: 0, conflicts: 0, alerts: 0, completed: 0 },
    sections: SECTION_ORDER.map(key => ({ key, title: key, total: 0, items: [] })) };
}
function withRow(key: "sessions" | "integrations" = "sessions"): Snapshot {
  const s = snapshot(), section = s.sections.find(x => x.key === key)!;
  section.total = 1; section.items.push({ id: "1", title: "subject", state: "reported", detail: "reason", timeline: [] }); return s;
}
test("invalid and future per-row timestamps explicitly downgrade trust", () => {
  for (const observedAt of ["invalid", "2026-09-19T13:00:00Z"]) {
    const p = presentSupervisor(withRow(), { nowMs: NOW, extensions: { "sessions:1": { observedAt } } });
    assert.equal(p.sections.find(x => x.key === "sessions")!.rows[0]!.trust, "Unknown");
  }
  assert.ok(snapshotFreshness("2026-09-19" + " ".repeat(100_000), NOW).unknown);
});
test("per-row event clipping remains explicit below the global timeline cap", () => {
  const s = withRow(); s.sections.find(x => x.key === "sessions")!.items[0]!.timeline = Array.from({ length: 4 }, () => ({ at: new Date(NOW).toISOString(), kind: "event", detail: "recorded" }));
  const p = presentSupervisor(s, { nowMs: NOW }); assert.equal(p.timeline.length, 3); assert.ok(p.truncated);
});
test("missing or duplicate section keys cannot claim a complete input", () => {
  for (const duplicate of [false, true]) {
    const s = snapshot(); s.sections.pop(); if (duplicate) s.sections.push(s.sections[0]!);
    const p = presentSupervisor(s, { nowMs: NOW, completeness: { data: "complete", input: "complete" } });
    assert.equal(p.dataComplete, "incomplete"); assert.equal(p.inputComplete, "incomplete");
  }
});
test("optional A fields preserve workspace and delivery data without a Verified upgrade", () => {
  const p = presentSupervisor(withRow(), { nowMs: NOW, extensions: { "sessions:1": { revision: 1, generation: 2, logicalSession: "s", incarnation: "i", attempt: "a", evidence: "e", deliveryEpisode: "d", workspace: "w", filesTouched: "f" } } });
  const r = p.sections.find(x => x.key === "sessions")!.rows[0]!;
  assert.equal(r.facts.length, 9); assert.match(r.facts.join(" "), /workspace.*filesTouched/); assert.notEqual(r.trust, "Verified");
});
test("old integration evaluation and stale snapshot timelines remain stale", () => {
  const s = withRow("integrations"), checkedAt = "2026-09-19T10:00:00Z";
  const p = presentSupervisor(s, { nowMs: NOW, extensions: { "integrations:1": { checkedAt } } });
  assert.equal(p.sections.find(x => x.key === "integrations")!.rows[0]!.trust, "Stale");
  s.generatedAt = checkedAt; s.sections.find(x => x.key === "integrations")!.items[0]!.timeline.push({ at: new Date(NOW).toISOString(), kind: "reported", detail: "event" });
  assert.equal(presentSupervisor(s, { nowMs: NOW }).timeline[0]!.trust, "Stale");
});

test("worst-case extension text has independent JSON, HTML and DOM bounds", () => {
  for (const text of ["r", "\u{1f600}<&\"".repeat(5000)]) {
    const s = snapshot(), extensions: Record<string, ObservationExtension> = {};
    for (const section of s.sections) {
      section.total = 8;
      section.items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: text, state: text, detail: text, timeline: Array.from({ length: 3 }, () => ({ at: new Date(NOW).toISOString(), kind: text, detail: text })) }));
      for (const row of section.items) extensions[`${section.key}:${row.id}`] = { revision: text, generation: text, logicalSession: text, incarnation: text, attempt: text, evidence: text, deliveryEpisode: text, workspace: text, filesTouched: text };
    }
    const context = { nowMs: NOW, extensions }, p = presentSupervisor(s, context), html = renderSupervisorPresentation(s, context);
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= PRESENTATION_LIMITS.jsonBytes);
    assert.ok(Buffer.byteLength(html) <= PRESENTATION_LIMITS.htmlBytes);
    assert.ok((html.match(/<details>/g) ?? []).length <= 88);
    assert.ok((html.match(/<[a-z]/g) ?? []).length < 10_000);
  }
});

test("untrusted adapter completeness cannot inject HTML or invent a trust enum", () => {
  const context = { nowMs: NOW, completeness: { data: '<img src=x onerror="alert(1)">' as never, input: "Verified" as never } };
  const p = presentSupervisor(snapshot(), context);
  assert.equal(p.dataComplete, "unknown"); assert.equal(p.inputComplete, "unknown");
  assert.doesNotMatch(renderSupervisorPresentation(snapshot(), context), /<img|<script/);
});

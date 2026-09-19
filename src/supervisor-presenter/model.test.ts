import assert from "node:assert/strict";
import test from "node:test";
import { displayText, presentSupervisor, snapshotFreshness, SECTION_ORDER, PRESENTATION_LIMITS, type Snapshot } from "./model.js";
import { renderSupervisorPresentation } from "./render.js";
const NOW = Date.parse("2026-09-19T12:00:00Z");
function fixture(text = "reported activity"): Snapshot {
  return { schemaVersion: 1, project: "p", generatedAt: new Date(NOW).toISOString(), truncated: false,
    counts: { active: 1, idle: 0, stalled: 0, blocked: 0, readyReview: 0, conflicts: 0, alerts: 0, completed: 0 },
    sections: SECTION_ORDER.map(key => ({ key, title: key, total: 1, items: [{ id: "1", title: text, state: key === "integrations" ? "merge_ready" : "unverified_changes", detail: text, timeline: [{ at: new Date(NOW).toISOString(), kind: "test_run", detail: text }] }] })) };
}
test("presenter is deterministic and does not mutate a frozen snapshot", () => {
  const s = fixture();
  const before = JSON.stringify(s);
  Object.freeze(s); Object.freeze(s.sections); s.sections.forEach(x => { Object.freeze(x); Object.freeze(x.items); });
  assert.deepEqual(presentSupervisor(s, { nowMs: NOW }), presentSupervisor(s, { nowMs: NOW }));
  assert.equal(JSON.stringify(s), before);
});
test("v1 completeness is unknown even with empty arrays and truncated=false", () => {
  const s = fixture(); s.sections.forEach(x => { x.items = []; x.total = 0; });
  const p = presentSupervisor(s, { nowMs: NOW });
  assert.equal(p.inputComplete, "unknown"); assert.equal(p.dataComplete, "unknown");
  assert.match(renderSupervisorPresentation(s, { nowMs: NOW }), /Empty output does not prove absence/);
});
test("observed heartbeat and test_run never become Verified or liveness proof", () => {
  const p = presentSupervisor(fixture(), { nowMs: NOW });
  assert.ok(p.sections.every(x => x.rows.every(r => r.trust !== "Verified")));
  assert.ok(p.timeline.every(x => x.trust !== "Verified"));
  assert.equal(p.sections.find(x => x.key === "integrations")!.rows[0]!.trust, "Unknown");
  assert.match(p.sections.find(x => x.key === "integrations")!.rows[0]!.state, /NOT merge authority/);
});
test("stale, invalid and future-clock timestamps are explicit", () => {
  assert.equal(snapshotFreshness("2026-09-19T11:00:00Z", NOW).stale, true);
  assert.equal(snapshotFreshness("garbage", NOW).unknown, true);
  assert.equal(snapshotFreshness("2026-09-19T13:00:00Z", NOW).unknown, true);
  assert.equal(snapshotFreshness(undefined, NOW).unknown, true);
  assert.equal(snapshotFreshness(new Date(NOW).toISOString(), NaN).unknown, true);
  const s = fixture(); s.generatedAt = "2026-09-19T11:00:00Z";
  assert.equal(presentSupervisor(s, { nowMs: NOW }).trust, "Stale");
});
test("optional reliability fields are reported, bounded and never assumed", () => {
  const p = presentSupervisor(fixture(), { nowMs: NOW, extensions: { "sessions:1": { incarnation: "i", attempt: "a", evidence: "e", generation: 2 } } });
  assert.match(p.sections.find(x => x.key === "sessions")!.rows[0]!.facts.join(" "), /attempt \(reported\): a/);
  assert.notEqual(p.sections.find(x => x.key === "sessions")!.rows[0]!.trust, "Verified");
  assert.equal(p.sections.find(x => x.key === "tasks")!.rows[0]!.facts.length, 0);
});
test("attention has subject, reason, severity, source, age and inspection without command", () => {
  const row = presentSupervisor(fixture(), { nowMs: NOW }).sections[0]!.rows[0]!;
  for (const key of ["title", "detail", "severity", "source", "age", "nextInspection"] as const) assert.ok(row[key]);
  assert.match(row.nextInspection, /session_events/);
  assert.doesNotMatch(row.nextInspection, /integration_gate|coordinator_claim|automation_poll/);
});
test("many rows and long Unicode remain bounded in model, JSON and HTML", () => {
  const s = fixture("\u4e2d\u{1f600}&<>\"'".repeat(5000));
  s.sections.forEach(x => { x.items = Array.from({ length: 5000 }, () => x.items[0]!); x.total = 5000; });
  const p = presentSupervisor(s, { nowMs: NOW });
  assert.ok(p.sections.every(x => x.rows.length <= 8)); assert.ok(p.timeline.length <= 40);
  assert.ok(Buffer.byteLength(JSON.stringify(p)) < 400_000);
  const html = renderSupervisorPresentation(s, { nowMs: NOW });
  assert.ok(Buffer.byteLength(html) <= PRESENTATION_LIMITS.htmlBytes);
  assert.ok((html.match(/<details>/g) ?? []).length <= 88);
  assert.match(html, /Truncated/);
});
for (const payload of ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "&lt;script&gt;", "\u202eevil\u2066", "a\n\r\tb", "[click](javascript:alert(1))", "\u0645\u0631\u062d\u0628\u0627"]) {
  test(`escaped inert display: ${JSON.stringify(payload)}`, () => {
    const html = renderSupervisorPresentation(fixture(payload), { nowMs: NOW });
    assert.doesNotMatch(html, /<script|<img|<button|<form|<a\s|<[^>]*\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /[\u202a-\u202e\u2066-\u2069]/);
    if (payload.startsWith("<script>")) assert.match(html, /&lt;script&gt;/);
  });
}
test("display text ignores object coercion and bounds invalid limits", () => {
  assert.equal(displayText({ toString() { throw new Error("not called"); } }), "Unknown");
  assert.equal(displayText("abc", NaN), "abc");
  assert.ok(displayText("x".repeat(10_000), Infinity).length <= 240);
});

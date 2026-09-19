import assert from "node:assert/strict";
import test from "node:test";
import { cardPresentation, cardSnapshot, cardSnapshotDiagnostic, type CardSnapshot } from "./chat-card-view.js";
const base: CardSnapshot = { probeId: "one", diagnosticVersion: 2, revision: 1, serverNow: 1000, expiresAt: 99999, state: "pending", waitStarted: false, waitActive: false, waitOutcome: null, waitDeadlineAt: null, receiptPhase: null };
test("card distinguishes not-started, active, local deadline, confirmed timeout and historical expiry", () => {
  assert.match(cardPresentation(base, 0).text, /尚未确认/);
  const active = { ...base, waitStarted: true, waitActive: true, waitDeadlineAt: 46000 };
  assert.equal(cardPresentation(active, 1000).remainingMs, 44000);
  assert.equal(cardPresentation(active, 45000).canSubmit, false);
  assert.match(cardPresentation(active, 45000).text, /估算/);
  const ended = cardPresentation({ ...active, waitActive: false, waitOutcome: "timeout" }, 0);
  assert.equal(ended.canSubmit, false); assert.match(ended.text, /已结束/);
  assert.equal(cardPresentation({ ...base, state: "expired" }, 0).canSubmit, false);
});
test("card distinguishes early, active, late and cancelled receipts without claiming model continuation", () => {
  for (const [phase, text] of [["before_wait", /暂存/], ["during_wait", /独立核对/], ["after_wait", /没有恢复/]] as const) {
    const shown = cardPresentation({ ...base, state: "answered", receiptPhase: phase }, 0);
    assert.equal(shown.canSubmit, false); assert.match(shown.text, text);
  }
  assert.equal(cardPresentation({ ...base, state: "cancelled" }, 0).canSubmit, false);
});
test("card rejects wrong probe or stale UI schema before enabling actions", () => {
  assert.deepEqual(cardSnapshot(base, "one"), base);
  for (const value of [null, {}, { ...base, probeId: "other" }, { ...base, diagnosticVersion: 1 }, { ...base, serverNow: NaN }]) assert.throws(() => cardSnapshot(value, "one"));
});
test("diagnostics identify invalid fields without echoing arbitrary values or secrets", () => {
  const diagnostic = cardSnapshotDiagnostic({ ...base, waitStarted: true, waitActive: true, waitDeadlineAt: undefined, submitToken: "secret-token", unrelated: "private-content" }, "one");
  assert.deepEqual(diagnostic.invalidFields, ["waitDeadlineAt"]);
  assert.equal(diagnostic.fieldTypes.waitDeadlineAt, "undefined");
  assert.ok(!JSON.stringify(diagnostic).includes("secret"));
  assert.ok(!JSON.stringify(diagnostic).includes("private"));
  assert.ok(!JSON.stringify(diagnostic).includes("submitToken"));
  assert.throws(() => cardSnapshot(undefined, "one"), /probeId/);
  assert.throws(() => cardSnapshot({ ...base, diagnosticVersion: 1 }, "one"), /diagnosticVersion/);
  assert.deepEqual(cardSnapshotDiagnostic(base, "one").invalidFields, []);
});

test("observed host omission of null deadline is normalized only before a timer exists", () => {
  const hostPayload = Object.fromEntries(Object.entries(base).filter(([, value]) => value !== null));
  const snapshot = cardSnapshot(hostPayload, "one");
  assert.equal(snapshot.waitDeadlineAt, null);
  assert.equal(snapshot.waitStarted, false);
  assert.equal(snapshot.waitActive, false);
  assert.equal(hostPayload.waitDeadlineAt, undefined, "Do not mutate the host result");
  const diagnostic = cardSnapshotDiagnostic(hostPayload, "one");
  assert.deepEqual(diagnostic.invalidFields, []);
  assert.deepEqual(diagnostic.normalizedFields, ["waitDeadlineAt"]);
  assert.equal(diagnostic.fieldTypes.waitDeadlineAt, "undefined");
  const early = cardSnapshot({ ...hostPayload, state: "answered", waitStarted: true, waitOutcome: "answer_already_recorded" }, "one");
  assert.equal(cardPresentation(early, 0).canSubmit, false);
});

test("host omission never invents or extends an active deadline or repairs mandatory fields", () => {
  for (const waitDeadlineAt of [undefined, null, "46000", NaN]) {
    assert.throws(() => cardSnapshot({ ...base, waitStarted: true, waitActive: true, waitDeadlineAt }, "one"), /waitDeadlineAt/);
  }
  assert.throws(() => cardSnapshot({ ...base, waitStarted: true, waitOutcome: "timeout", waitDeadlineAt: undefined }, "one"), /waitDeadlineAt/);
  for (const key of ["probeId", "revision", "diagnosticVersion", "serverNow", "expiresAt", "state", "waitStarted", "waitActive"]) {
    assert.throws(() => cardSnapshot({ ...base, [key]: undefined }, "one"));
  }
  const active = cardSnapshot({ ...base, waitStarted: true, waitActive: true, waitDeadlineAt: 46000 }, "one");
  assert.equal(cardPresentation(active, 45000).canSubmit, false);
});

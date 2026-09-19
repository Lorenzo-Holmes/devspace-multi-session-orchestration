import assert from "node:assert/strict";
import test from "node:test";
import { classifyContinuationError, detectContextPressure, type ContextSignal } from "./signals.js";

const now = 1_000_000;
const signal = (kind: ContextSignal["kind"], value: number, observedAtMs = now): ContextSignal => ({
  kind, value, observedAtMs, source: { kind: kind === "host_context_length_error" ? "host" : "server", reference: "observation:123" },
});
test("missing and stale signals mean unknown, not low or context full", () => {
  assert.equal(detectContextPressure([], now).level, "unknown");
  assert.equal(detectContextPressure([signal("turn_count", 300, now - 300_001)], now).level, "unknown");
  assert.equal(detectContextPressure([signal("turn_count", 300, now + 1)], now).level, "unknown");
});
test("conversation age alone never recommends rollover", () => {
  const result = detectContextPressure([signal("conversation_age_ms", 24 * 60 * 60_000)], now);
  assert.equal(result.level, "moderate");
  assert.equal(result.confidence, "low");
});
test("an actual zero counter is distinguishable from missing telemetry", () => {
  assert.equal(detectContextPressure([signal("turn_count", 0)], now).level, "low");
});
test("one high volume signal is only a low-confidence heuristic", () => {
  assert.equal(detectContextPressure([signal("turn_count", 120)], now).level, "high");
});
test("two different high-volume signals recommend rollover without inventing a token percentage", () => {
  const result = detectContextPressure([signal("turn_count", 120), signal("tool_output_bytes", 2 * 1024 * 1024)], now);
  assert.equal(result.level, "rollover_recommended");
  assert.equal(result.confidence, "moderate");
  assert.equal("percent" in result, false);
  assert.equal(result.signals[0].source.reference, "observation:123");
});
test("repeating one signal 64 times cannot amplify confidence", () => {
  const result = detectContextPressure(Array.from({ length: 64 }, () => signal("turn_count", 120)), now);
  assert.equal(result.level, "high");
  assert.equal(result.discardedSignalCount, 63);
});
test("latest snapshot wins; conflicting simultaneous snapshots use the lower value", () => {
  const older = signal("turn_count", 300, now - 1), newer = signal("turn_count", 1);
  assert.equal(detectContextPressure([older, newer], now).level, "low");
  assert.equal(detectContextPressure([signal("turn_count", 300), newer], now).level, "low");
  assert.equal(detectContextPressure([newer, signal("turn_count", 300)], now).level, "low");
});
test("explicit host context error is high-confidence critical pressure", () => {
  const result = detectContextPressure([signal("host_context_length_error", 1)], now);
  assert.equal(result.level, "critical");
  assert.equal(result.confidence, "high");
});
for (const bad of [signal("turn_count", -1), signal("turn_count", Infinity),
  { ...signal("host_context_length_error", 1), source: { kind: "server", reference: "log" } },
  signal("host_context_length_error", 0), { ...signal("turn_count", 1), source: undefined },
  { ...signal("turn_count", 1), kind: "heartbeat_stale" },
  { ...signal("turn_count", 1), source: { kind: "server", reference: "valid-reference\n" } }]) {
  test(`invalid/unattributed signal rejected: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => detectContextPressure([bad], now));
  });
}
test("signal collection and freshness limits are bounded", () => {
  assert.throws(() => detectContextPressure(Array.from({ length: 65 }, () => signal("turn_count", 1)), now));
  assert.throws(() => detectContextPressure([], NaN));
  assert.throws(() => detectContextPressure([], now, -1));
});
for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "WS_DISCONNECT"]) {
  test(`${code} is not context exhaustion`, () => {
    assert.deepEqual(classifyContinuationError({ source: "network", code }), { category: "network_transient", action: "retry_existing" });
  });
}
for (const code of ["security_check_unavailable", "auto_review_failure", "security_denied", "browser_security_temporary_failure"]) {
  test(`${code} fails closed without a desktop fallback`, () => {
    assert.deepEqual(classifyContinuationError({ source: "browser", code }), { category: "browser_security", action: "waiting_user_approval" });
  });
}
for (const code of ["login_required", "mfa_required", "oauth_consent_required", "security_key_required", "totp_required", "email_verification_required"]) {
  test(`${code} requires the user`, () => assert.equal(classifyContinuationError({ source: "host", code }).action, "waiting_user_approval"));
}
for (const httpStatus of [408, 429, 500, 502, 503]) {
  test(`HTTP ${httpStatus} retries the existing host rather than creating a chat`, () => {
    assert.equal(classifyContinuationError({ source: "host", httpStatus }).category, "host_transient");
  });
}
test("structured host context codes are the only context rollover candidates", () => {
  assert.equal(classifyContinuationError({ source: "host", code: "context_length_exceeded" }).action, "rollover_candidate");
  assert.equal(classifyContinuationError({ source: "browser", code: "context_length_exceeded" }).category, "unknown");
  assert.equal(classifyContinuationError({ source: "host", message: "context_length_exceeded" }).category, "unknown");
  assert.equal(classifyContinuationError({ source: "host", code: "context_length_exceeded", httpStatus: 403 }).category, "permission");
  assert.equal(classifyContinuationError({ source: "host", httpStatus: 401 }).category, "authentication");
});

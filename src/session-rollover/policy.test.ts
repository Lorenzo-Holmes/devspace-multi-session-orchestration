import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRolloverPolicy, rolloverPolicySchema, type PolicyHistory } from "./policy.js";

const now = 10_000_000;
const history: PolicyHistory = { rolloverCount: 0, consecutiveRecoveryFailures: 0, activeAttempt: false };
const enabled = { enabled: true };
test("rollover is disabled by default with bounded conservative settings", () => {
  const policy = rolloverPolicySchema.parse({});
  assert.equal(policy.enabled, false);
  assert.equal(policy.recoveryEnabled, false);
  assert.equal(policy.maxRolloversPerLogicalSession, 6);
  assert.equal(policy.maxConsecutiveRecoveryFailures, 2);
  assert.equal(policy.minIntervalMinutes, 15);
  assert.equal(evaluateRolloverPolicy({}, history, "manual", now).status, "disabled");
});
for (const input of [{ enabled: "true" }, { maxRolloversPerLogicalSession: 0 }, { maxRolloversPerLogicalSession: 101 },
  { maxConsecutiveRecoveryFailures: Infinity }, { minIntervalMinutes: -1 }, { cooldownMinutes: 0 },
  { bootstrapTimeoutMs: NaN }, { safePointTimeoutMs: 999 }, { takeoverTimeoutMs: 600_001 }, { force: true }]) {
  test(`reject unsafe policy: ${JSON.stringify(input)}`, () => assert.throws(() => rolloverPolicySchema.parse(input)));
}
test("eligibility is a pure advisory decision and does not mutate inputs", () => {
  const input = Object.freeze({ ...history });
  assert.deepEqual(evaluateRolloverPolicy(Object.freeze(enabled), input, "context_pressure", now),
    { status: "eligible", eligible: true, advisoryOnly: true });
  assert.deepEqual(input, history);
});
for (const [policy, trigger, status] of [
  [{ ...enabled, mode: "manual" }, "context_pressure", "manual_only"],
  [{ ...enabled, mode: "manual" }, "manual", "eligible"],
  [{ ...enabled, mode: "recommended" }, "manual", "recommended_only"],
  [enabled, "confirmed_conversation_failure", "recovery_disabled"],
  [{ ...enabled, recoveryEnabled: true }, "confirmed_conversation_failure", "eligible"],
  [enabled, "none", "not_triggered"],
] as const) test(`${trigger} respects ${status}`, () => {
  assert.equal(evaluateRolloverPolicy(policy, history, trigger, now).status, status);
});
test("all triggers coalesce against an unresolved durable attempt", () => {
  for (const trigger of ["manual", "context_pressure", "confirmed_conversation_failure"]) {
    assert.equal(evaluateRolloverPolicy(enabled, { ...history, activeAttempt: true }, trigger, now).status, "coalesced");
  }
});
test("session limit also applies to manual requests", () => {
  assert.equal(evaluateRolloverPolicy(enabled, { ...history, rolloverCount: 6, lastStartedAtMs: 0 }, "manual", now).status, "limit_reached");
});
test("failure cap pauses instead of endlessly retrying", () => {
  assert.equal(evaluateRolloverPolicy(enabled, { ...history, consecutiveRecoveryFailures: 2, lastFailureAtMs: 0 }, "manual", now).status, "paused_needs_attention");
});
test("minimum interval includes exact boundary", () => {
  const h = { ...history, rolloverCount: 1, lastStartedAtMs: now };
  assert.equal(evaluateRolloverPolicy(enabled, h, "manual", now + 899_999).retryAfterMs, 1);
  assert.equal(evaluateRolloverPolicy(enabled, h, "manual", now + 900_000).status, "eligible");
});
test("failure cooldown dominates shorter minimum interval", () => {
  const h = { ...history, rolloverCount: 1, lastStartedAtMs: now, consecutiveRecoveryFailures: 1, lastFailureAtMs: now };
  assert.equal(evaluateRolloverPolicy(enabled, h, "manual", now + 900_000).retryAfterMs, 900_000);
  assert.equal(evaluateRolloverPolicy(enabled, h, "manual", now + 1_800_000).status, "eligible");
});
for (const bad of [{ ...history, rolloverCount: -1 }, { ...history, rolloverCount: 1 },
  { ...history, consecutiveRecoveryFailures: 1 }, { ...history, lastStartedAtMs: now + 1 },
  { ...history, lastFailureAtMs: now + 1 }, { ...history, activeAttempt: undefined }]) {
  test(`incomplete/future history fails closed: ${JSON.stringify(bad)}`, () => {
    assert.equal(evaluateRolloverPolicy(enabled, bad, "manual", now).status, "invalid_observation");
  });
}
test("unknown trigger and invalid clock never authorize rollover", () => {
  assert.equal(evaluateRolloverPolicy(enabled, history, "heartbeat_stale", now).status, "invalid_observation");
  assert.equal(evaluateRolloverPolicy(enabled, history, "manual", NaN).status, "invalid_observation");
});
test("six-hour virtual policy simulation remains bounded (not an epoch lifecycle simulation)", () => {
  let h = { ...history };
  let eligible = 0;
  for (let at = 0; at <= 6 * 60 * 60_000; at += 60_000) {
    if (evaluateRolloverPolicy(enabled, h, "context_pressure", at).eligible) {
      eligible++;
      h = { ...h, rolloverCount: eligible, lastStartedAtMs: at } as PolicyHistory;
    }
  }
  assert.equal(eligible, 6);
});

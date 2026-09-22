import assert from "node:assert/strict";
import test from "node:test";
import { assessBrowserPreflight, assessSafePoint, safePointChecks, type BrowserExpectation,
  type BrowserPreflightSnapshot, type SafePointSnapshot } from "./safety.js";

const now = 100_000;
const safe = (): SafePointSnapshot => Object.fromEntries(safePointChecks.map(key => [key,
  { status: "clear", observedAtMs: now, source: "test:observation" }])) as SafePointSnapshot;
test("safe point requires complete fresh positive observations and remains advisory", () => {
  assert.deepEqual(assessSafePoint(safe(), now), { state: "safe", reasons: [], advisoryOnly: true });
  assert.equal(assessSafePoint({}, now).state, "uncertain");
});
for (const key of safePointChecks) {
  test(`safe point blocks busy ${key}`, () => {
    const snapshot = safe(); snapshot[key].status = "busy";
    assert.equal(assessSafePoint(snapshot, now).state, key === "pendingApprovals" ? "waiting_user_approval" : "wait");
  });
  test(`safe point rejects unknown or stale ${key}`, () => {
    const snapshot = safe(); snapshot[key].status = "unknown";
    assert.equal(assessSafePoint(snapshot, now).state, "uncertain");
    snapshot[key].status = "clear"; snapshot[key].observedAtMs = now - 30_001;
    assert.equal(assessSafePoint(snapshot, now).state, "uncertain");
  });
}
test("future observations and invalid clocks cannot establish a safe point", () => {
  const snapshot = safe(); snapshot.fileWrites.observedAtMs = now + 1;
  assert.equal(assessSafePoint(snapshot, now).state, "uncertain");
  assert.equal(assessSafePoint(safe(), Infinity).state, "uncertain");
});
const expected: BrowserExpectation = { browserId: "browser1", tabId: "tab1", accountId: "account1", workspaceId: "workspace1" };
const browser = (): BrowserPreflightSnapshot => ({
  browserId: "browser1", requestedTabId: "tab1", tabId: "tab1", currentUrl: "https://chatgpt.com/", observedAtMs: now,
  accountId: "account1", workspaceId: "workspace1", browserSecurity: "approved", originPermission: "approved",
  hostPermission: "approved", authentication: "authenticated", devspace: "connected", catalog: "current",
});
test("ready preflight is explicitly not takeover authority", () => {
  assert.deepEqual(assessBrowserPreflight(expected, browser(), now), {
    state: "ready", reason: "preflight_only_not_takeover_authority", advisoryOnly: true,
  });
});
for (const field of ["browserId", "requestedTabId", "tabId"] as const) {
  test(`exact ${field} mismatch blocks arbitrary tab selection`, () => {
    assert.equal(assessBrowserPreflight(expected, { ...browser(), [field]: "different" }, now).state, "blocked_browser_target");
  });
}
test("provider tab alias must match the exact requested ID", () => {
  assert.equal(assessBrowserPreflight(expected, { ...browser(), tabId: "internal1", providerTabId: "tab1" }, now).state, "ready");
});
for (const currentUrl of ["http://chatgpt.com/", "https://chatgpt.com.evil.example/", "https://evil.example/",
  "https://chatgpt.com@evil.example/", "https://user:secret@chatgpt.com/", "https://chatgpt.com:8443/",
  "https://chatgpt.com\\@evil.example/", "https://chatgpt.com/\n", "not-a-url"]) {
  test(`reject untrusted origin: ${JSON.stringify(currentUrl)}`, () => {
    assert.equal(assessBrowserPreflight(expected, { ...browser(), currentUrl }, now).state, "blocked_browser_security");
  });
}
for (const browserSecurity of ["denied", "unavailable", "failed"] as const) {
  test(`Browser Use ${browserSecurity} fails closed`, () => {
    assert.equal(assessBrowserPreflight(expected, { ...browser(), browserSecurity }, now).state, "blocked_browser_security");
  });
}
for (const patch of [{ browserSecurity: "required" }, { originPermission: "required" }, { hostPermission: "required" },
  { authentication: "login_required" }, { authentication: "mfa_required" }]) {
  test(`no automatic approval for ${JSON.stringify(patch)}`, () => {
    assert.equal(assessBrowserPreflight(expected, { ...browser(), ...patch }, now).state, "waiting_user_approval");
  });
}
for (const patch of [{ accountId: "wrong" }, { workspaceId: "wrong" }, { accountId: undefined }, { workspaceId: undefined }]) {
  test(`unknown or wrong identity blocks continuation: ${JSON.stringify(patch)}`, () => {
    assert.equal(assessBrowserPreflight(expected, { ...browser(), ...patch }, now).state, "blocked_account_identity");
  });
}
test("missing permissions, DevSpace and stale catalog cannot produce readiness", () => {
  assert.equal(assessBrowserPreflight(expected, { ...browser(), originPermission: "unknown" }, now).state, "blocked_browser_security");
  assert.equal(assessBrowserPreflight(expected, { ...browser(), devspace: "unavailable" }, now).state, "blocked_devspace");
  assert.equal(assessBrowserPreflight(expected, { ...browser(), catalog: "stale" }, now).state, "blocked_stale_catalog");
  assert.equal(assessBrowserPreflight(expected, { ...browser(), catalog: "unknown" }, now).state, "blocked_stale_catalog");
});
test("preflight rejects stale, future and incomplete snapshots", () => {
  assert.equal(assessBrowserPreflight(expected, browser(), now + 30_001).state, "uncertain");
  assert.equal(assessBrowserPreflight(expected, browser(), now - 1).state, "uncertain");
  assert.equal(assessBrowserPreflight(expected, {}, now).state, "uncertain");
  assert.equal(assessBrowserPreflight({ ...expected, accountId: undefined }, browser(), now).state, "uncertain");
});

test("exact root URL is valid; trailing control characters in identity are not", () => {
  assert.equal(assessBrowserPreflight(expected, { ...browser(), currentUrl: "https://chatgpt.com" }, now).state, "ready");
  assert.equal(assessBrowserPreflight(expected, { ...browser(), accountId: "account1\n" }, now).state, "uncertain");
});

import * as z from "zod/v4";
import { timestampSchema } from "./policy.js";

export const safePointChecks = ["mutationTools", "fileWrites", "gitOperations", "worktreeProvisioning",
  "pendingApprovals", "uncommittedTestResults", "unreconciledJournals", "browserMutations", "activeProcesses"] as const;
const evidence = z.strictObject({
  status: z.enum(["clear", "busy", "unknown"]),
  observedAtMs: timestampSchema,
  source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}(?![\s\S])/),
});
const safePointSchema = z.record(z.enum(safePointChecks), evidence);
export type SafePointSnapshot = z.infer<typeof safePointSchema>;
export type SafePointDecision = {
  state: "safe" | "wait" | "waiting_user_approval" | "uncertain";
  reasons: string[];
  advisoryOnly: true;
};

/** A fresh read is not a lock. Recheck under reliability's mutation/reservation boundary. */
export function assessSafePoint(raw: unknown, nowMs: number, maxAgeMs = 30_000): SafePointDecision {
  const snapshot = safePointSchema.safeParse(raw);
  if (!snapshot.success || !timestampSchema.safeParse(nowMs).success
    || !z.number().int().min(1).max(300_000).safeParse(maxAgeMs).success) {
    return { state: "uncertain", reasons: ["invalid_observation"], advisoryOnly: true };
  }
  const unknown: string[] = [], busy: string[] = [];
  for (const key of safePointChecks) {
    const item = snapshot.data[key];
    if (item.observedAtMs > nowMs || nowMs - item.observedAtMs > maxAgeMs || item.status === "unknown") unknown.push(key);
    else if (item.status === "busy") busy.push(key);
  }
  const state = busy.includes("pendingApprovals") ? "waiting_user_approval"
    : unknown.length ? "uncertain" : busy.length ? "wait" : "safe";
  return { state, reasons: [...unknown.map(key => `unknown:${key}`), ...busy.map(key => `busy:${key}`)], advisoryOnly: true };
}

const id = z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+(?![\s\S])/);
const expectedBrowserSchema = z.strictObject({ browserId: id, tabId: id, accountId: id, workspaceId: id });
const browserSnapshotSchema = z.strictObject({
  browserId: id, requestedTabId: id, tabId: id, providerTabId: id.optional(),
  currentUrl: z.string().min(1).max(2048), observedAtMs: timestampSchema,
  accountId: id.optional(), workspaceId: id.optional(),
  browserSecurity: z.enum(["approved", "required", "denied", "unavailable", "failed"]),
  originPermission: z.enum(["approved", "required", "denied", "unknown"]),
  hostPermission: z.enum(["approved", "required", "denied", "unknown"]),
  authentication: z.enum(["authenticated", "login_required", "mfa_required", "unknown"]),
  devspace: z.enum(["connected", "unavailable", "unknown"]),
  catalog: z.enum(["current", "stale", "unknown"]),
});
export type BrowserExpectation = z.infer<typeof expectedBrowserSchema>;
export type BrowserPreflightSnapshot = z.infer<typeof browserSnapshotSchema>;
export type BrowserPreflightDecision = {
  state: "ready" | "waiting_user_approval" | "blocked_browser_security" | "blocked_browser_target"
    | "blocked_account_identity" | "blocked_devspace" | "blocked_stale_catalog" | "uncertain";
  reason: string;
  advisoryOnly: true;
};

/** Decision-only boundary, NOT a production launcher or an approval verifier.
 * Only a trusted adapter may produce this snapshot; never accept it from MCP/model args.
 * No fallback desktop transport, OAuth flow, private API or consent mutation exists here.
 */
export function assessBrowserPreflight(rawExpected: unknown, rawSnapshot: unknown, nowMs: number): BrowserPreflightDecision {
  const expected = expectedBrowserSchema.safeParse(rawExpected), parsed = browserSnapshotSchema.safeParse(rawSnapshot);
  const answer = (state: BrowserPreflightDecision["state"], reason: string): BrowserPreflightDecision => ({ state, reason, advisoryOnly: true });
  if (!expected.success || !parsed.success || !timestampSchema.safeParse(nowMs).success) return answer("uncertain", "invalid_observation");
  const e = expected.data, s = parsed.data;
  if (s.observedAtMs > nowMs || nowMs - s.observedAtMs > 30_000) return answer("uncertain", "stale_observation");
  if (s.browserId !== e.browserId || s.requestedTabId !== e.tabId
    || (s.tabId !== e.tabId && s.providerTabId !== e.tabId)) return answer("blocked_browser_target", "exact_browser_tab_mismatch");
  try {
    const url = new URL(s.currentUrl);
    if (/[\u0000-\u0020\u007f\\]/.test(s.currentUrl) || url.origin !== "https://chatgpt.com"
      || url.username || url.password || !(s.currentUrl === "https://chatgpt.com" || s.currentUrl.startsWith("https://chatgpt.com/"))) {
      return answer("blocked_browser_security", "unexpected_origin");
    }
  } catch { return answer("blocked_browser_security", "invalid_url"); }
  if (["denied", "unavailable", "failed"].includes(s.browserSecurity)
    || s.originPermission === "denied" || s.hostPermission === "denied") return answer("blocked_browser_security", "security_fail_closed");
  if (s.browserSecurity === "required" || s.originPermission === "required" || s.hostPermission === "required"
    || s.authentication === "login_required" || s.authentication === "mfa_required") return answer("waiting_user_approval", "new_platform_approval_required");
  if (s.originPermission !== "approved" || s.hostPermission !== "approved" || s.authentication !== "authenticated") {
    return answer("blocked_browser_security", "security_state_unverified");
  }
  if (s.accountId !== e.accountId || s.workspaceId !== e.workspaceId) return answer("blocked_account_identity", "account_or_workspace_unverified");
  if (s.devspace !== "connected") return answer("blocked_devspace", "devspace_not_verified");
  if (s.catalog !== "current") return answer("blocked_stale_catalog", "catalog_not_verified");
  return answer("ready", "preflight_only_not_takeover_authority");
}

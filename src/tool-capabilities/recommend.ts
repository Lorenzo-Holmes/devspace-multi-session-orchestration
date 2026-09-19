import { catalogForProfile, REVIEW_BASELINE } from "./catalog.js";
import type { CatalogProfile, Role, ToolCapability } from "./types.js";
export interface RecommendationContext {
  role: Role;
  /** A classified workflow intent, NOT arbitrary natural language or an instruction. */
  intent?: string;
  workspace: "unknown" | "none" | "read" | "modify" | "authorized-path";
  sessionKnown?: boolean;
  taskKnown?: boolean;
  revisionKnown?: boolean;
  currentTaskAuthority?: boolean;
  existingRecord?: boolean;
  ownerKnown?: boolean;
  targetFresh?: boolean;
  realHumanChannel?: boolean;
  durableGrant?: boolean;
  explicitUserContinuation?: boolean;
  userRequestedAction?: boolean;
  humanGate?: "not-required" | "approved" | "pending" | "denied" | "unknown";
  /** Exact names from the host's current catalog; an empty list means no tools. */
  hostToolNames?: readonly string[];
  profile?: Readonly<CatalogProfile>;
}
export interface ToolAdvice { toolName: string; reasons: readonly string[]; nextInspection: readonly string[] }
export interface Recommendations {
  advisoryOnly: true;
  authorization: false;
  recommended: ToolAdvice[];
  available: ToolAdvice[];
  discouraged: ToolAdvice[];
  hiddenCandidate: ToolAdvice[];
}
function missingContext(tool: ToolCapability, c: Readonly<RecommendationContext>): string[] {
  const p = tool.prerequisites, reasons: string[] = [];
  if (p.workspace === "read" && !["read", "modify"].includes(c.workspace)) reasons.push("workspace-read-unknown");
  if (p.workspace === "modify" && c.workspace !== "modify") reasons.push("workspace-modify-unknown");
  if (p.workspace === "authorized-path" && !["authorized-path", "read", "modify"].includes(c.workspace)) reasons.push("authorized-path-unknown");
  if (p.session !== "none" && c.sessionKnown !== true) reasons.push("session-unknown");
  if (p.task === "required" && c.taskKnown !== true) reasons.push("task-unknown");
  if (p.revision === "required" && c.revisionKnown !== true) reasons.push("revision-unknown");
  if (p.requiresCurrentTaskAuthority && c.currentTaskAuthority !== true) reasons.push("current-task-authority-unknown");
  const checks: readonly [string, boolean | undefined, string][] = [
    ["requiresExistingRecordOrHostNativeArtifact", c.existingRecord, "existing-record-unknown"],
    ["requiresVerifiedOwnerOrClientRecordIdentity", c.ownerKnown, "owner-unknown"],
    ["requiresRealHostFormOrAcknowledgedCardChannel", c.realHumanChannel, "real-human-channel-unknown"],
    ["requiresDurableWorkspaceGrant", c.durableGrant, "durable-grant-unknown"],
    ["requiresExplicitUserContinuationOrDiagnosticRequest", c.explicitUserContinuation, "explicit-continuation-absent"],
  ];
  for (const [condition, value, reason] of checks) if (p.conditions.includes(condition) && value !== true) reasons.push(reason);
  if (tool.mutability === "mutate") {
    if (c.userRequestedAction !== true || !c.intent) reasons.push("explicit-action-absent");
    if (p.conditions.includes("requiresFreshTrustedTargetBeforeAction") && c.targetFresh !== true) reasons.push("fresh-target-unknown");
    if (tool.risk === "high" && !["approved", "not-required"].includes(c.humanGate ?? "unknown")) reasons.push("human-gate-unresolved");
  }
  return reasons;
}
/** Pure advice: no registration, tool invocation, tokens, clock, storage, authority or side effects. */
export function recommendTools(context: Readonly<RecommendationContext>): Recommendations {
  const result: Recommendations = { advisoryOnly: true, authorization: false, recommended: [], available: [], discouraged: [], hiddenCandidate: [] };
  const catalog = catalogForProfile(context.profile ?? REVIEW_BASELINE);
  const host = context.hostToolNames === undefined ? undefined : new Set(context.hostToolNames);
  for (const tool of catalog) {
    const advice = (reasons: string[]): ToolAdvice => ({ toolName: tool.toolName, reasons, nextInspection: tool.typicalPredecessors });
    if (host && !host.has(tool.toolName)) { result.hiddenCandidate.push(advice(["absent-from-current-host-catalog"])); continue; }
    if (tool.visibility === "app-only" || tool.constraints.includes("modelMustNotSubmit")) { result.hiddenCandidate.push(advice(["app-only-never-model-submit"])); continue; }
    if (!tool.recommendedRoles.includes(context.role)) { result.discouraged.push(advice(["outside-advisory-role"])); continue; }
    const reasons = missingContext(tool, context);
    if (reasons.length) { result.discouraged.push(advice(reasons)); continue; }
    if (context.intent === tool.intent) result.recommended.push(advice(["intent-match-context-observed-server-must-recheck"]));
    else result.available.push(advice(["workflow-candidate-not-authorized"]));
  }
  return result;
}

import { catalogForProfile, REVIEW_BASELINE } from "./catalog.js";
import { ROLES, type CatalogProfile, type Role, type ToolCapability } from "./types.js";
export type GuidanceBucket = "recommended" | "conditional" | "humanGated" | "defaultForbidden";
/** Role labels express workflow preference, never membership, authentication or permission. */
export function roleBucket(role: Role, tool: ToolCapability): GuidanceBucket {
  if (tool.visibility === "app-only" || tool.constraints.includes("modelMustNotSubmit")) return "humanGated";
  if (!tool.recommendedRoles.includes(role)) return "defaultForbidden";
  if (tool.prerequisites.humanApproval === "required") return "humanGated";
  if (tool.mutability === "mutate" || tool.risk === "high") return "conditional";
  return "recommended";
}
export function roleManifest(profile: Readonly<CatalogProfile> = REVIEW_BASELINE) {
  const tools = catalogForProfile(profile);
  return ROLES.map(role => {
    const buckets: Record<GuidanceBucket, string[]> = { recommended: [], conditional: [], humanGated: [], defaultForbidden: [] };
    for (const tool of tools) buckets[roleBucket(role, tool)].push(tool.toolName);
    return { role, advisoryOnly: true as const, authorization: false as const, ...buckets };
  });
}

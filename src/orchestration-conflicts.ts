import { resolve } from "node:path";
import { normalizeIntentPath, type OrchestrationFileIntent, type OrchestrationSession } from "./orchestration-store.js";

export interface OrchestrationConflict {
  sessionA: string;
  sessionB: string;
  projectKey: string;
  workspaceRoot: string;
  pathA: string;
  pathB: string;
  accessA: "read" | "write";
  accessB: "read" | "write";
  severity: "medium" | "high";
  reason: "exact_path" | "path_scope_overlap";
}

const terminalStates = new Set(["completed", "failed", "abandoned"]);

export function detectOrchestrationConflicts(
  sessions: readonly OrchestrationSession[],
  intents: readonly OrchestrationFileIntent[],
  limit = 200,
): OrchestrationConflict[] {
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid conflict output limit.");
  const boundedLimit = limit === Number.POSITIVE_INFINITY ? limit : Math.min(limit, 500);
  const intentOwners = new Set(intents.map(intent => intent.sessionId));
  const active = sessions
    .filter((session) => !terminalStates.has(session.state) && intentOwners.has(session.id))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const bySession = new Map<string, OrchestrationFileIntent[]>();
  for (const intent of intents) {
    const list = bySession.get(intent.sessionId) ?? [];
    list.push(intent);
    bySession.set(intent.sessionId, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path) || a.access.localeCompare(b.access));
  }

  const conflicts: OrchestrationConflict[] = [];
  for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
    const left = active[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
      const right = active[rightIndex];
      if (left.projectKey !== right.projectKey) continue;
      if (resolve(left.workspaceRoot) !== resolve(right.workspaceRoot)) continue;
      for (const a of bySession.get(left.id) ?? []) {
        for (const b of bySession.get(right.id) ?? []) {
          if (a.access === "read" && b.access === "read") continue;
          const overlap = pathOverlap(a.path, b.path);
          if (!overlap) continue;
          conflicts.push({
            sessionA: left.id,
            sessionB: right.id,
            projectKey: left.projectKey,
            workspaceRoot: resolve(left.workspaceRoot),
            pathA: normalizeIntentPath(a.path),
            pathB: normalizeIntentPath(b.path),
            accessA: a.access,
            accessB: b.access,
            severity: a.access === "write" && b.access === "write" ? "high" : "medium",
            reason: normalizeIntentPath(a.path) === normalizeIntentPath(b.path)
              ? "exact_path"
              : "path_scope_overlap",
          });
          if (conflicts.length >= boundedLimit) return conflicts;
        }
      }
    }
  }
  return conflicts;
}

function pathOverlap(left: string, right: string): boolean {
  const a = normalizeIntentPath(left);
  const b = normalizeIntentPath(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

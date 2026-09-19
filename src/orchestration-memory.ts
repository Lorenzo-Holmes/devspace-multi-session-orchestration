import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";

const list = z.array(z.string().trim().min(1).max(1000)).max(100);
export const memoryPatchSchema = z.object({
  objective: z.string().max(8000).optional(), frozenDecisions: list.optional(), architectureConstraints: list.optional(),
  completedMilestones: list.optional(), knownFailures: list.optional(), forbiddenRegressions: list.optional(),
});
export interface ProjectMemory extends DurableRecord {
  objective: string; frozenDecisions: string[]; architectureConstraints: string[]; completedMilestones: string[];
  knownFailures: string[]; forbiddenRegressions: string[];
}
export class ProjectMemoryManager {
  constructor(private readonly store: OrchestrationV2Store) {}
  get(project: string): ProjectMemory {
    const id = "memory_" + createHash("sha256").update(project).digest("hex");
    return this.store.get<ProjectMemory>("project_memory", project, id) ?? {
      id, projectKey: project, revision: 0, objective: "", frozenDecisions: [], architectureConstraints: [],
      completedMilestones: [], knownFailures: [], forbiddenRegressions: [], createdAt: "", updatedAt: "",
    };
  }
  update(project: string, expectedRevision: number, raw: z.infer<typeof memoryPatchSchema>): ProjectMemory {
    const patch = Object.fromEntries(Object.entries(memoryPatchSchema.parse(raw)).filter(([, value]) => value !== undefined));
    if (!Object.keys(patch).length) throw new Error("Explicit project memory fields are required.");
    return this.store.transaction(() => {
      const current = this.get(project);
      if (current.revision !== expectedRevision) throw new Error("Project memory revision conflict.");
      const now = new Date().toISOString();
      const next: ProjectMemory = { ...current, ...patch, updatedAt: now, createdAt: current.createdAt || now };
      if (Buffer.byteLength(JSON.stringify(next)) > 128 * 1024) throw new Error("Project memory exceeds 128 KiB bound.");
      return current.revision === 0 ? this.store.insert("project_memory", { ...next, revision: 1 })
        : this.store.update("project_memory", next, expectedRevision);
    });
  }
}

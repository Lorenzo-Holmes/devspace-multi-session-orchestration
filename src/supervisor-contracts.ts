import * as z from "zod/v4";
const line = z.string().max(1000);
const timelineSchema = z.object({ at: z.string().max(100), kind: z.string().max(100), detail: line });
export const supervisorItemSchema = z.object({ id: line, title: line, state: z.string().max(100), detail: line, timeline: z.array(timelineSchema).max(10) });
export const supervisorSectionNames = ["sessions", "tasks", "readyTasks", "claimedTasks", "blockedTasks", "bindings", "conflicts", "handoffs", "integrations", "alerts", "needsAttention"] as const;
const sectionSchema = z.object({ key: z.enum(supervisorSectionNames), title: line, total: z.number().int().nonnegative(), items: z.array(supervisorItemSchema).max(50) });
export const supervisorSummarySchema = z.object({
  schemaVersion: z.literal(1), project: line, generatedAt: z.string().max(100), truncated: z.boolean(),
  counts: z.object({ active: z.number(), idle: z.number(), stalled: z.number(), blocked: z.number(), readyReview: z.number(), conflicts: z.number(), alerts: z.number(), completed: z.number() }),
  sections: z.array(sectionSchema).length(supervisorSectionNames.length),
});
export type SupervisorSummary = z.infer<typeof supervisorSummarySchema>;
export type SupervisorItem = z.infer<typeof supervisorItemSchema>;

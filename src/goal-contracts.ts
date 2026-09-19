import * as z from "zod/v4";

const key = z.string().trim().min(1).max(256);
export const goalSpecSchema = z.object({
  objective: z.string().trim().min(1).max(4000).refine(
    value => !/【在这里|\[在这里|\[fill in|<your goal>/i.test(value),
    "Replace the example placeholder with an actual objective.",
  ),
  successCriteria: z.string().trim().min(1).max(12000),
  constraints: z.string().trim().max(12000).default(""),
  tokenBudget: z.number().int().positive().optional(),
}).strict();
export type GoalSpec = z.infer<typeof goalSpecSchema>;
export const goalRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), ownerRef: key, workspaceRoot: key,
    requestKey: key, spec: goalSpecSchema }).strict(),
  z.object({ action: z.literal("status"), ownerRef: key, goalRef: key }).strict(),
  z.object({ action: z.literal("list"), ownerRef: key, workspaceRoot: key.optional() }).strict(),
  ...(["pause", "resume", "stop"] as const).map(action => z.object({
    action: z.literal(action), ownerRef: key, goalRef: key, requestKey: key,
    expectedRevision: z.number().int().positive(),
  }).strict()),
]);
export type GoalRequest = z.infer<typeof goalRequestSchema>;
export interface GoalReply { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; retryable: false } }
export interface GoalApi { goal(request: GoalRequest): Promise<GoalReply> }
export interface ManagedGoalConfig {
  enabled: boolean;
  shrimpEntryPoint: string;
  dataRoot: string;
  codexCommand?: string;
}
export function goalError(error: unknown): GoalReply {
  const message = error instanceof Error ? error.message : "Goal operation failed.";
  const code = message.match(/^[A-Z][A-Z_]+(?=:|$)/)?.[0] ?? "GOAL_OPERATION_FAILED";
  return { ok: false, error: { code, message: message.slice(0,1000), retryable: false } };
}

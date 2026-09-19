import * as z from "zod/v4";

const text = z.string().trim().min(1);
const taskName = text.max(100).refine(value => !/["`&|<>^%!\r\n]/.test(value), "Unsafe Shrimp task name");
export const chatArtifactCheckSchema = z.object({
  path: text.max(500).refine(value => !/^(?:[a-z]:|[\\/])/i.test(value)
    && !value.split(/[\\/]/).some(part => ["..", ".git", "node_modules"].includes(part.toLowerCase()))
    && !/[:\x00]/.test(value), "Use a project-relative artifact path"),
  contains: text.max(2000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const chatGoalSpecSchema = z.object({
  objective: text.max(4000).refine(value => !/【在这里|\[在这里|<your goal>/i.test(value), "Provide an actual objective"),
  successCriteria: text.max(8000),
  constraints: z.string().max(8000).default(""),
  tasks: z.array(z.object({
    name: taskName,
    description: text.min(10).max(4000),
    implementationGuide: text.max(4000),
    dependencies: z.array(taskName).max(20).default([]),
    checks: z.array(chatArtifactCheckSchema).min(1).max(10),
  }).strict()).min(1).max(20),
}).strict().superRefine((spec, ctx) => {
  if (JSON.stringify(spec).length > 80000) ctx.addIssue({code:"custom", message:"Goal contract exceeds 80,000 characters"});
  const graph = new Map(spec.tasks.map(task => [task.name, task.dependencies]));
  if (graph.size !== spec.tasks.length) ctx.addIssue({code:"custom", message:"Duplicate task name"});
  const active = new Set<string>(), done = new Set<string>();
  const visit = (name: string): boolean => {
    if (!graph.has(name) || active.has(name)) return false;
    if (done.has(name)) return true;
    active.add(name);
    for (const dep of graph.get(name)!) if (!visit(dep)) return false;
    active.delete(name); done.add(name); return true;
  };
  if ([...graph.keys()].some(name => !visit(name))) ctx.addIssue({code:"custom", message:"Unknown or cyclic dependency"});
});
export type ChatGoalSpec = z.infer<typeof chatGoalSpecSchema>;
export interface ChatGoalConfig { enabled: boolean; shrimpEntryPoint: string; dataRoot: string }
export const chatGoalKey = text.max(256);
export const chatGoalRevision = z.number().int().positive();
export const chatQuestionSchema = z.object({
  question: text.max(1500),
  choices: z.array(text.max(200)).min(2).max(6),
}).strict().refine(value => new Set(value.choices).size === value.choices.length, "Choices must be distinct");
export type ChatQuestion = z.infer<typeof chatQuestionSchema>;

export const CHAT_GOAL_BOUNDARIES = {
  executor: "chatgpt_chat",
  additionalModelCalls: 0,
  modelCallAccountingScope: "this controller only; not account-wide usage or arbitrary shell commands",
  localModelRuntime: "none",
  hostTurnState: "not_observable",
  chatUsageAccounting: "unknown_host_controlled",
  canWakeEndedHostTurn: false,
  pauseScope: "task controller only; existing generic shell sessions are not interrupted",
  acceptanceScope: "frozen file checks plus host assessment; not an independent semantic grader",
} as const;

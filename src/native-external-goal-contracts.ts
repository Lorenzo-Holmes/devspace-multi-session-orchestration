import * as z from "zod/v4";

/** Proposed fork protocol, NOT an API implemented by stock Codex. */
export const EXTERNAL_GOAL_PROTOCOL = "devspace.codex-native-goal-external/v1" as const;
export const EXTERNAL_GOAL_PREFIX = "devspace/nativeGoalExternal/" as const;
export const UPSTREAM_AUDITED_COMMIT = "b348fc26674189f758d5941cdab3f78f258b2aa7";
const key = z.string().trim().min(1).max(256);
export const requestKeySchema = key;
const integer = z.number().int().safe().positive();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const bindingSchema = z.object({
  principalRef: key,
  workspaceRoot: z.string().min(1).max(4096),
}).strict();
export type ExternalGoalBinding = z.infer<typeof bindingSchema>;

export const externalCapabilitiesSchema = z.object({
  protocol: z.literal(EXTERNAL_GOAL_PROTOCOL),
  implementation: z.literal("codex-native-patched"),
  storeId: key,
  runtimeInstanceId: key,
  executableSha256: sha256Schema,
  executionPolicy: z.literal("external_only"),
  nativeGoalPersistence: z.literal(true),
  atomicExternalBinding: z.literal(true),
  durableExecutionPolicy: z.literal(true),
  modelDispatchFence: z.literal(true),
  revisionCas: z.literal(true),
  leaseFencing: z.literal(true),
  operationDeduplication: z.literal(true),
  creationIdentityRecovery: z.literal(true),
  checkpointPersistence: z.literal(true),
  automaticModelTurns: z.literal(false),
  implicitResume: z.literal(false),
}).strict();
export type ExternalCapabilities = z.infer<typeof externalCapabilitiesSchema>;

export const goalRefSchema = z.object({ threadId: key, goalId: key }).strict();
export type ExternalGoalRef = z.infer<typeof goalRefSchema>;
const scoped = { ref: goalRefSchema, expectedRevision: integer, requestKey: key };
const leased = { ...scoped, leaseToken: key, fence: integer };
const evidenceSchema = z.object({
  path: z.string().min(1).max(2048).refine(value => {
    const normalized = value.replaceAll("\\", "/");
    return !normalized.startsWith("/") && !normalized.includes(":")
      && !normalized.includes("\0")
      && normalized.split("/").every(part => part !== ".." && part !== "." && part !== "");
  }, "Evidence must use a normalized, relative workspace path."),
  sha256: sha256Schema,
}).strict();

export const externalCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), requestKey: key,
    objective: z.string().trim().min(1).max(4000),
    successCriteria: z.string().trim().min(1).max(12000),
  }).strict(),
  z.object({ kind: z.literal("claim"), ...scoped,
    leaseDurationSeconds: z.number().int().min(15).max(300),
  }).strict(),
  z.object({ kind: z.literal("checkpoint"), ...leased,
    summary: z.string().trim().min(1).max(12000),
    nextAction: z.string().trim().min(1).max(4000),
    evidence: z.array(evidenceSchema).max(30),
  }).strict(),
  z.object({ kind: z.literal("handoff"), ...leased, checkpointRef: key }).strict(),
  z.object({ kind: z.literal("complete"), ...leased, checkpointRef: key,
    evidence: z.array(evidenceSchema).min(1).max(30),
  }).strict(),
  z.object({ kind: z.literal("control"), ...scoped,
    action: z.enum(["pause", "resume", "stop"]),
  }).strict(),
]);
export type ExternalCommand = z.infer<typeof externalCommandSchema>;

export const externalViewSchema = z.object({
  ref: goalRefSchema,
  revision: integer,
  fence: z.number().int().safe().nonnegative(),
  executionPolicy: z.literal("external_only"),
  nativeStatus: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
  externalState: z.enum(["ready", "leased", "handoff", "paused", "stopped", "completed", "blocked"]),
  checkpointRef: key.nullable(),
}).strict();
export type ExternalGoalView = z.infer<typeof externalViewSchema>;
const envelope = { storeId: key, runtimeInstanceId: key };
export const statusEnvelopeSchema = z.object({ ...envelope, view: externalViewSchema.nullable() }).strict();
export const receiptSchema = z.object({
  ...envelope, requestKey: key, requestFingerprint: sha256Schema,
  outcome: z.enum(["applied", "rejected"]),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),
  view: externalViewSchema.nullable(),
  lease: z.object({ token: key, fence: integer, expiresAt: z.iso.datetime() }).strict().nullable(),
}).strict();
export type ExternalReceipt = z.infer<typeof receiptSchema>;
export const operationEnvelopeSchema = z.object({
  ...envelope, requestKey: key, requestFingerprint: sha256Schema,
  state: z.enum(["applied", "rejected", "pending", "notFound"]),
  // Only an applied create returns identity. Historical lease tokens are never returned.
  createdRef: goalRefSchema.nullable(),
}).strict();

export class ExternalGoalError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(`${code}: ${message}`, options); }
}

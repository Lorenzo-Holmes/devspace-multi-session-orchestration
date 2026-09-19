import * as z from "zod/v4";
import { CHAT_GOAL_BOUNDARIES } from "./chat-goal-contracts.js";

// Output contracts describe wire data, without parsing/stripping the replies or
// changing persisted records. Only the upstream Shrimp task extension is open.
const text=z.string(), count=z.number().int().nonnegative(), revision=z.number().int().positive();
const boundary=z.strictObject({
  executor:z.literal(CHAT_GOAL_BOUNDARIES.executor),additionalModelCalls:z.literal(0),
  modelCallAccountingScope:z.literal(CHAT_GOAL_BOUNDARIES.modelCallAccountingScope),
  localModelRuntime:z.literal("none"),hostTurnState:z.literal("not_observable"),
  chatUsageAccounting:z.literal("unknown_host_controlled"),canWakeEndedHostTurn:z.literal(false),
  pauseScope:z.literal(CHAT_GOAL_BOUNDARIES.pauseScope),acceptanceScope:z.literal(CHAT_GOAL_BOUNDARIES.acceptanceScope),
});
const state=z.enum(["ready","paused","waiting_for_user","completed","stopped","needs_reconciliation"]);
const dependency=z.strictObject({taskId:z.string().uuid()});
const taskSummary=z.strictObject({id:z.string().uuid(),name:text,status:z.enum(["pending","in_progress","completed","blocked"]),dependencies:z.array(dependency)});
const check=z.strictObject({path:text,contains:text.optional(),sha256:text.optional()});
const contract=z.strictObject({name:text,description:text,implementationGuide:text,dependencies:z.array(text),checks:z.array(check)});
const nextTask=z.looseObject({...taskSummary.shape,description:text,createdAt:text,updatedAt:text,
  summary:text.optional(),completedAt:text.optional(),contract:contract.optional(),
}).describe("Original Shrimp task including its upstream extension fields and frozen local contract.");
const interaction=z.union([
  z.strictObject({status:z.literal("decision_expired"),nextAction:text}),
  z.strictObject({status:z.enum(["host_form_unsupported","question_already_open"]),sameTurnContinuation:z.literal("unverified")}),
  z.strictObject({status:z.literal("pending_after_transport_or_timeout"),sameTurnContinuation:z.literal("unverified"),message:text}),
]);
export const chatGoalViewSchema=z.strictObject({...boundary.shape,goalRef:text,revision,state,objective:text,
  successCriteria:text,constraints:text,nextAction:z.enum(["reconcile","stop","await_user","paused","resume_handoff","inspect_then_renew_lease","execute_claimed_task","inspect_existing_claim","claim_next_task","final_acceptance_required"]),
  error:text.nullable(),tasks:z.array(taskSummary).optional(),nextTask:nextTask.nullable(),
  lease:z.strictObject({taskId:z.string().uuid(),expiresAt:count,token:z.string().uuid().optional()}).nullable(),
  handoff:z.strictObject({id:z.string().uuid(),taskId:z.string().uuid().nullable(),createdAt:count,expiresAt:count,state:z.enum(["pending","consumed","expired"]),consumedAt:count.optional()}).nullable(),
  continuation:z.strictObject({handoffTool:z.literal("chat_goal_handoff"),resumeTool:z.literal("chat_goal_resume"),autoContinueWithinActiveTurn:z.literal(true),requiresExplicitUserContinuationAfterTurnEnd:z.literal(true)}),
  decision:z.strictObject({id:z.string().uuid(),question:text,choices:z.array(text),expiresAt:count,
    state:z.enum(["pending","accepted","declined","cancelled"]),answer:text.optional()}).nullable(),
  proofs:z.record(text,z.strictObject({artifacts:z.array(z.strictObject({path:text,sha256:text,bytes:count})),
    hostAssessment:text,recordedAt:text,projectCommit:text.optional()})),
  taskHash:text.nullable(),taskCommit:text.nullable(),instruction:text,
});
const goalList=z.strictObject({...boundary.shape,goals:z.array(z.strictObject({goalRef:text,objective:text,revision,state}))});
const preflight=z.strictObject({...boundary.shape,policy:z.enum(["form_required","form_or_verified_card"]),
  checkScope:z.enum(["verified_oauth_client_card_receipt","current_mcp_connection"]),status:z.enum(["card_transport_verified","capability_declared","blocked"]),
  canCreateOrClaim:z.boolean(),formCapability:z.enum(["declared","not_declared"]),formDelivery:z.literal("unverified"),
  cardDelivery:z.literal("acknowledged_by_app").optional(),cardReceiptLifetimeMinutes:z.literal(15).optional(),
  sameTurnContinuation:z.literal("unverified"),permissionCardSupport:z.literal("not_checked"),cardChannelAvailable:z.boolean().optional(),
  nextAction:z.enum(["open_authorized_workspace_then_create_or_inspect_existing_goal","connect_card_channel_before_goal_mutation","stop_before_goal_mutation"]),instruction:text,
});
const startupBlock=z.strictObject({goalMutationAttempted:z.literal(false),preflight});
export const chatGoalCardViewSchema=z.strictObject({
  cardId:z.string().uuid(),kind:z.enum(["connection","decision"]),revision,serverNow:count,expiresAt:count,
  goalRef:text.nullable(),decisionId:z.string().uuid().nullable(),question:text,choices:z.array(text),
  acknowledged:z.boolean(),canSubmit:z.boolean(),waitStarted:z.boolean(),waitActive:z.boolean(),waitDeadlineAt:count.nullable(),
  waitOutcome:z.enum(["answer_received","answer_already_recorded","channel_ready","timeout","transport_aborted","service_closed","superseded","decision_closed"]).nullable(),
  answer:text.nullable(),activeWaitAtSubmission:z.boolean().nullable(),receiptPhase:z.enum(["before_wait","during_wait"]).nullable(),
  state:z.enum(["expired","answered","closed","pending"]),
  nextAction:z.enum(["use_card_channel","read_goal_status_then_continue_if_ready","read_status_then_stop","wait_already_active","wait_once"]),
  sameTurnContinuation:z.literal("unverified"),chatUsageAccounting:z.literal("unknown_host_controlled"),additionalModelCalls:z.literal(0),followUpMessagesSent:z.literal(0),
  goal:chatGoalViewSchema.optional(),replayed:z.boolean().optional(),
});
const error=z.strictObject({code:text,message:text});
// MCP requires an object at the schema root. Cross-field checks additionally
// enforce the success/error envelope at runtime; no permissive data catch-all.
function reply(data:z.ZodType) {
  return z.strictObject({ok:z.boolean(),data:data.optional(),error:error.optional(),replayed:z.boolean().optional()})
    .superRefine((r,ctx)=>{
      if(r.ok ? r.data===undefined||r.error!==undefined : r.error===undefined)
        ctx.addIssue({code:"custom",message:"Success requires data and no error; failure requires an error."});
    });
}
export const chatGoalOutputSchemas={
  chat_goal_preflight:reply(preflight),
  chat_goal_create:reply(z.union([chatGoalViewSchema,startupBlock])),
  chat_goal_status:reply(z.union([chatGoalViewSchema,goalList])),
  chat_goal_status_by_path:reply(z.union([chatGoalViewSchema,goalList])),
  chat_goal_next:reply(z.union([chatGoalViewSchema,startupBlock])),
  chat_goal_complete:reply(chatGoalViewSchema),
  chat_goal_handoff:reply(chatGoalViewSchema),
  chat_goal_resume:reply(z.union([chatGoalViewSchema,startupBlock])),
  chat_goal_control:reply(chatGoalViewSchema),
  chat_goal_ask:reply(chatGoalViewSchema.extend({interaction:interaction.optional()})),
  chat_goal_card_connect:reply(chatGoalCardViewSchema),
  chat_goal_card_ready:reply(chatGoalCardViewSchema),
  chat_goal_ask_card:reply(chatGoalCardViewSchema),
  chat_goal_show_decision:reply(chatGoalCardViewSchema),
  chat_goal_wait_decision:reply(chatGoalCardViewSchema),
  chat_goal_card_status:reply(chatGoalCardViewSchema),
  chat_goal_card_submit:reply(chatGoalCardViewSchema),
};
export type ChatGoalToolName=keyof typeof chatGoalOutputSchemas;

import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { CHAT_GOAL_BOUNDARIES } from "./chat-goal-contracts.js";
import type { ChatReply } from "./chat-goal-store.js";

/** This preview requires form questions. Inspect only the current SDK-negotiated
 * connection; never accept model-supplied capabilities or persist a previous pass.
 * The SDK normalizes legacy elicitation: {} to form: {} during initialization. */
export function chatGoalPreflight(capabilities: ClientCapabilities | undefined, card?: {available:boolean;verified:boolean}) {
  const formDeclared = capabilities?.elicitation?.form !== undefined;
  if (card?.verified) return {
    ...CHAT_GOAL_BOUNDARIES, policy:"form_or_verified_card" as const,
    checkScope:"verified_oauth_client_card_receipt" as const, status:"card_transport_verified" as const,
    canCreateOrClaim:true, formCapability:formDeclared?"declared":"not_declared", formDelivery:"unverified",
    cardDelivery:"acknowledged_by_app", cardReceiptLifetimeMinutes:15,
    sameTurnContinuation:"unverified", permissionCardSupport:"not_checked",
    nextAction:"open_authorized_workspace_then_create_or_inspect_existing_goal",
    instruction:"A short-lived authenticated card acknowledgement passed. This is not a filesystem permission, a same-conversation/liveness claim, or a promise that later cards will render. Keep this cardChannelId for create/next/ask_card. Each decision still requires its own app-only token and explicit choice. Reconnect after expiry or service restart; never bypass a pending decision.",
  };
  return {
    ...CHAT_GOAL_BOUNDARIES,
    policy: card?.available ? "form_or_verified_card" as const : "form_required" as const,
    checkScope: "current_mcp_connection" as const,
    status: formDeclared ? "capability_declared" as const : "blocked" as const,
    canCreateOrClaim: formDeclared,
    formCapability: formDeclared ? "declared" as const : "not_declared" as const,
    formDelivery: "unverified" as const,
    sameTurnContinuation: "unverified" as const,
    permissionCardSupport: "not_checked" as const,
    cardChannelAvailable:card?.available??false,
    nextAction: formDeclared ? "open_authorized_workspace_then_create_or_inspect_existing_goal" : card?.available ? "connect_card_channel_before_goal_mutation" : "stop_before_goal_mutation",
    instruction: formDeclared
      ? "Only the current connection's form capability declaration passed. Card delivery, same-turn continuation and usage accounting are not verified. Workspace access, contract validation and all other checks still apply."
      : card?.available ? "No native form capability or verified card receipt. Before any Goal mutation call chat_goal_card_connect with a new requestKey, then chat_goal_card_ready once. Continue only after the real app acknowledgement returns channel_ready; otherwise stop. A model-supplied assertion cannot enable the channel."
      : "This connection does not declare form elicitation required by this preview. Do not create or claim tasks, retry unchanged requests, choose a default answer, or silently downgrade to a no-card workflow. Existing Goals remain queryable and stoppable. A new host connection must be checked again; this result cannot enable host capabilities.",
  };
}

/** No controller, journal, Shrimp process or project mutation occurs on refusal. */
export function chatGoalStartupBlock(capabilities: ClientCapabilities | undefined, card?: {available:boolean;verified:boolean}): ChatReply | undefined {
  const preflight = chatGoalPreflight(capabilities,card);
  if (preflight.canCreateOrClaim) return undefined;
  return {
    ok: false,
    error: {
      code: "HOST_FORM_UNSUPPORTED",
      message: "The current MCP connection does not declare required form elicitation. This create/claim request was blocked before any Goal mutation. Previous Goals were not changed; inspect status rather than assuming no previous Goal exists.",
    },
    data: { goalMutationAttempted: false, preflight },
  };
}

import * as z from "zod/v4";
import { chatGoalOutputSchemas } from "./chat-goal-output.js";
import { chatGoalPhase } from "./chat-goal-diagnostics.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import { chatGoalKey, chatGoalRevision, chatGoalSpecSchema, chatQuestionSchema } from "./chat-goal-contracts.js";
import { ChatGoalController, chatGoalFailure, type ChatGoalContext } from "./chat-goal-controller.js";
import type { ChatReply } from "./chat-goal-store.js";
import { chatGoalPreflight, chatGoalStartupBlock } from "./chat-goal-preflight.js";
import { READ_TOOL_ANNOTATIONS } from "./tool-surfaces/types.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ChatGoalCards } from "./chat-goal-cards.js";
import { chatCardIdentity, registerChatGoalCardTools } from "./chat-goal-card-tools.js";
import { openAiConversationScopeId } from "./request-meta.js";

const output=(reply:ChatReply)=>({isError:!reply.ok,content:[{type:"text" as const,text:JSON.stringify(reply)}],structuredContent:reply as unknown as Record<string,unknown>});
const annotations={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const mutation={
  workspaceId:z.string().describe("Existing DevSpace workspace identifier. This does not grant or increase filesystem access."),
  goalRef:chatGoalKey.describe("Existing local Chat Goal identifier."),
  requestKey:chatGoalKey.describe("Local idempotency key. Reuse this exact key and arguments after an uncertain reply. A replayed reply is historical; read status before acting."),
  expectedRevision:chatGoalRevision.describe("Expected local Chat Goal revision used for compare-and-swap concurrency control."),
};
const goalLeaseToken=z.string().uuid().describe("Opaque local task-lease concurrency identifier returned by this Chat Goal. It is not an authentication credential, account token, filesystem permission, process permission, or model authorization.");

export function registerChatGoalTools(server:McpServer,controller:ChatGoalController,workspaces:WorkspaceRegistry,access:WorkspaceAccessManager,card?:{service:ChatGoalCards;html:string;scope:string}):void {
  const channelSchema={cardChannelId:z.string().uuid().optional().describe("Identifier of a short-lived app acknowledgement proving the Goal card transport is available. It is not a filesystem/process permission or authentication credential.")};
  const cardCheck=(auth:unknown,id?:string)=>card?{available:true,verified:card.service.verified(chatCardIdentity(auth),id)}:undefined;
  const assertOwner=(auth:unknown):void=>{
    const identity=auth as {clientId?:string;extra?:Record<string,unknown>}|undefined;
    if (!identity?.clientId || identity.extra?.devspaceOwnerRef!=="single-user") throw new Error("AUTHENTICATION_REQUIRED: verified OAuth owner required.");
  };
  const context=(workspaceId:string,auth:unknown):ChatGoalContext=>{
    assertOwner(auth);
    const workspace=workspaces.getWorkspace(workspaceId);
    return {ownerRef:"single-user",workspaceRoot:workspace.root,authorize:async()=>{
      const current=workspaces.getWorkspace(workspaceId);access.assertWorkspaceModifiable(current);
      const actual=await realpath(current.root);
      if (actual.toLowerCase()!==resolve(workspace.root).toLowerCase()) throw new Error("WORKSPACE_ACCESS_REQUIRED: project path changed; reopen after inspection.");
    }};
  };
  server.registerTool("chat_goal_preflight",{outputSchema:chatGoalOutputSchemas.chat_goal_preflight,title:"Check this Chat connection before starting a Goal",
    description:"Call first, even before opening a workspace. Read-only check of this connection's native form capability or an app-acknowledged cardChannelId. If nextAction=connect_card_channel_before_goal_mutation, call card_connect then card_ready once; otherwise a blocked result means stop. No Goal, permission, same-turn or quota guarantee. Creation and each claim enforce the same check. Never supply fabricated capabilities or silently omit required cards.",
    inputSchema:channelSchema,annotations:READ_TOOL_ANNOTATIONS,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{assertOwner(extra.authInfo);return output({ok:true,data:chatGoalPreflight(server.server.getClientCapabilities(),cardCheck(extra.authInfo,args.cardChannelId))});}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_create",{outputSchema:chatGoalOutputSchemas.chat_goal_create,title:"Create a Chat-driven Goal",
    description:"Create a finite durable task contract for the current ChatGPT Chat model to execute through DevSpace. First pass chat_goal_preflight, using a real cardChannelId if native forms are unavailable. Missing both blocks creation before mutation. Does not start Codex, an API/local model, or a background turn. Freeze task checks and dependencies first; then claim, execute, complete and continue through dependency-ready tasks while this host turn is active. If unfinished work must cross a user turn, call chat_goal_handoff before ending and chat_goal_resume only after an explicit later user continuation. Host turn limits and quota remain host-controlled.",
    inputSchema:{workspaceId:z.string(),requestKey:chatGoalKey,spec:chatGoalSpecSchema,...channelSchema},annotations,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{assertOwner(extra.authInfo);const blocked=chatGoalStartupBlock(server.server.getClientCapabilities(),cardCheck(extra.authInfo,args.cardChannelId));if(blocked)return output(blocked);return output(await controller.create(context(args.workspaceId,extra.authInfo),args.requestKey,args.spec));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_status",{outputSchema:chatGoalOutputSchemas.chat_goal_status,title:"Read Chat Goal progress",
    description:"Read persisted Chat Goal state, original Shrimp tasks, next action, handoff/resume cursor, decisions and evidence. Omit goalRef to discover Goals in this exact workspace across conversations. Never interprets persistence or a task lease as model liveness. Does not expose lease tokens, start models, or wake an ended Chat request.",
    inputSchema:{workspaceId:z.string(),goalRef:chatGoalKey.optional()},annotations:READ_TOOL_ANNOTATIONS,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{return output(await controller.status(context(args.workspaceId,extra.authInfo),args.goalRef));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_status_by_path",{outputSchema:chatGoalOutputSchemas.chat_goal_status,title:"Read Chat Goal progress by project path",
    description:"Read persisted Chat Goal state directly from an already-authorized existing project path. This is strictly read-only: it does not open or create a workspace, request stronger access, create a lease, change Goal revision, answer a decision, execute commands, or modify project files.",
    inputSchema:{path:z.string().min(1),goalRef:chatGoalKey.optional()},annotations:READ_TOOL_ANNOTATIONS,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{
    assertOwner(extra.authInfo);
    const conversationScopeId=openAiConversationScopeId(extra._meta);
    const authorization=await access.authorizeWorkspacePath(args.path,conversationScopeId,"read");
    const workspaceRoot=await realpath(authorization.path);
    const ctx:ChatGoalContext={ownerRef:"single-user",workspaceRoot,authorize:async()=>{
      const current=await access.authorizeWorkspacePath(workspaceRoot,conversationScopeId,"read");
      const actual=await realpath(current.path);
      if(actual.toLowerCase()!==resolve(workspaceRoot).toLowerCase()) throw new Error("WORKSPACE_ACCESS_REQUIRED: project path changed; inspect access before reading Goal state.");
    }};
    return output(await controller.status(ctx,args.goalRef));
  }catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_next",{outputSchema:chatGoalOutputSchemas.chat_goal_next,title:"Advance local Chat Goal task state",
    description:"Deterministically update only DevSpace's local Chat Goal coordination state: mark the one already-frozen dependency-ready task in progress, or renew that exact task's existing local lease. This call does not execute the task, run shell or GUI actions, modify project files, access the network, change permissions, send messages, or start Codex/API/local/subagent models. It rechecks native form capability or a real unexpired cardChannelId before the local state update; missing both leaves the Goal unchanged. The returned 10-minute lease is an opaque local concurrency identifier, not a credential or permission. After this call returns, the current Chat model may separately use already-authorized DevSpace tools to perform the task. Inspect tracked command outcomes before retrying uncertain external effects.",
    inputSchema:{...mutation,leaseToken:goalLeaseToken.optional(),...channelSchema},annotations,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{assertOwner(extra.authInfo);const blocked=chatGoalStartupBlock(server.server.getClientCapabilities(),cardCheck(extra.authInfo,args.cardChannelId));if(blocked)return output(blocked);return output(await controller.next(context(args.workspaceId,extra.authInfo),args));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_complete",{outputSchema:chatGoalOutputSchemas.chat_goal_complete,title:"Verify and complete the claimed task",
    description:"Submit the current Chat model's substantive acceptance assessment. Independently checks real project artifacts against the frozen checks, records hashes and Git checkpoints, then completes the original Shrimp task and returns the successor. This is not an independent semantic model grade. While the same host turn remains active, immediately continue to the successor instead of waiting for another user message. If the turn must end with unfinished work, call chat_goal_handoff once. On completed/stop, stop executing.",
    inputSchema:{...mutation,taskId:z.string().uuid().describe("Identifier of the already-claimed local Chat Goal task."),leaseToken:goalLeaseToken,assessment:z.string().trim().min(30).max(4000)},annotations,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{return output(await controller.complete(context(args.workspaceId,extra.authInfo),args));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_handoff",{outputSchema:chatGoalOutputSchemas.chat_goal_handoff,title:"Save a Chat Goal turn handoff",
    description:"Persist a short-lived handoff cursor before intentionally ending a host turn with unfinished Goal work. This does not execute a task, create or renew a task lease, call Codex/API/local models, send a follow-up message, or wake a future Chat turn. A later explicit user continuation can use chat_goal_resume with the returned handoff ID.",
    inputSchema:{...mutation},annotations,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{return output(await controller.handoff(context(args.workspaceId,extra.authInfo),args));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_resume",{outputSchema:chatGoalOutputSchemas.chat_goal_resume,title:"Resume a handed-off Chat Goal",
    description:"Use only after an explicit new user request to continue a previously handed-off Goal. Rechecks native form capability or a real unexpired cardChannelId. Resumes only the exact live handoff: if a task lease already exists, renews and returns that same lease rather than claiming another task; if no lease exists, returns the current pending successor for normal chat_goal_next claiming. Does not start Codex, API/local models, a background turn, or a new Chat message.",
    inputSchema:{...mutation,handoffId:z.string().uuid(),...channelSchema},annotations,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{assertOwner(extra.authInfo);const blocked=chatGoalStartupBlock(server.server.getClientCapabilities(),cardCheck(extra.authInfo,args.cardChannelId));if(blocked)return output(blocked);return output(await controller.resume(context(args.workspaceId,extra.authInfo),args));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_control",{outputSchema:chatGoalOutputSchemas.chat_goal_control,title:"Pause, resume or stop Chat task coordination",
    description:"Control task claiming/completion only; cannot interrupt an existing generic shell process or revive an ended Chat turn. Inspect/interrupt tracked command sessions separately when required. Resume never bypasses unanswered decisions or terminal Goals. No native Codex/API model call.",
    inputSchema:{...mutation,action:z.enum(["pause","resume","stop"])},annotations,
  },async(args,extra)=>{chatGoalPhase("input_validated");try{return output(await controller.control(context(args.workspaceId,extra.authInfo),args));}catch(e){return output(chatGoalFailure(e));}});
  server.registerTool("chat_goal_ask",{outputSchema:chatGoalOutputSchemas.chat_goal_ask,title:"Ask a bounded in-request question",
    description:"Persist a non-sensitive business choice and request a host-rendered MCP form during this tool call if supported. Never use for passwords, credentials or filesystem/process permissions: use the dedicated access tools for those. Reuse the original request key to show a still-pending choice again. Wait is bounded to 50 seconds; unsupported hosts, timeout or disconnect retain the pending decision. Does not send a follow-up Chat message, start a model or promise free quota/same-turn continuation.",
    inputSchema:{...mutation,...chatQuestionSchema.shape},annotations:{...annotations,idempotentHint:false},
  },async(args,extra)=>{chatGoalPhase("input_validated");
    try {
      const ctx=context(args.workspaceId,extra.authInfo);
      chatQuestionSchema.parse({question:args.question,choices:args.choices});
      const persisted=await controller.ask(ctx,args);
      if (!persisted.ok) return output(persisted);
      const current=await controller.status(ctx,args.goalRef);
      if (!current.ok) return output(current);
      const decision=current.data?.decision as {id:string;state:string;question:string;choices:string[];expiresAt:number}|null;
      if (!decision || decision.state!=="pending") return output(current);
      if (decision.expiresAt<=Date.now()) return output({...current,data:{...current.data,interaction:{status:"decision_expired",nextAction:"Pause to invalidate the old question, then ask again with a new request key. No answer was granted."}}});
      if (!server.server.getClientCapabilities()?.elicitation?.form) return output({...current,data:{...current.data,interaction:{status:"host_form_unsupported",sameTurnContinuation:"unverified"}}});
      const release=controller.beginQuestionPresentation(args.goalRef,decision.id);
      if (!release) return output({...current,data:{...current.data,interaction:{status:"question_already_open",sameTurnContinuation:"unverified"}}});
      try {
        const result=await server.server.elicitInput({mode:"form",message:decision.question,
          requestedSchema:{type:"object",properties:{answer:{type:"string",title:"请选择",enum:decision.choices}},required:["answer"]},
        },{timeout:50_000,signal:extra.signal,relatedRequestId:extra.requestId});
        return output(await controller.resolveDecision(ctx,args.goalRef,decision.id,{action:result.action,answer:typeof result.content?.answer==="string"?result.content.answer:undefined}));
      } catch (error) {
        return output({...current,data:{...current.data,interaction:{status:"pending_after_transport_or_timeout",sameTurnContinuation:"unverified",message:chatGoalFailure(error).error!.message}}});
      } finally {release();}
    } catch(error) { return output(chatGoalFailure(error)); }
  });
  if(card)registerChatGoalCardTools(server,controller,card.service,card.html,context,card.scope);
}

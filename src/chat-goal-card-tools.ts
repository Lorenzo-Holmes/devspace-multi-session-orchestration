import * as z from "zod/v4";
import { chatGoalOutputSchemas } from "./chat-goal-output.js";
import { chatGoalPhase } from "./chat-goal-diagnostics.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChatGoalController, ChatGoalContext } from "./chat-goal-controller.js";
import { chatGoalFailure } from "./chat-goal-controller.js";
import { chatGoalKey, chatGoalRevision, chatQuestionSchema } from "./chat-goal-contracts.js";
import { CHAT_GOAL_CARD_URI, ChatGoalCards } from "./chat-goal-cards.js";

export function chatCardIdentity(auth:unknown):string {
  const a=auth as {clientId?:string;extra?:Record<string,unknown>}|undefined;
  if (!a?.clientId || a.extra?.devspaceOwnerRef!=="single-user") throw new Error("AUTHENTICATION_REQUIRED: verified OAuth owner required.");
  return JSON.stringify([a.extra.devspaceOwnerRef,a.clientId]);
}
export function registerChatGoalCardTools(server:McpServer,controller:ChatGoalController,cards:ChatGoalCards,html:string,
  context:(workspaceId:string,auth:unknown)=>ChatGoalContext,scope:string) {
  const securitySchemes=[{type:"oauth2",scopes:[scope]}];
  const annotations={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const viewMeta={securitySchemes,ui:{resourceUri:CHAT_GOAL_CARD_URI,visibility:["model","app"]}};
  const appMeta={securitySchemes,ui:{visibility:["app"]}};
  const result=(data:Record<string,unknown>)=>({isError:false,content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:{ok:true,data}});
  const failure=(e:unknown)=>{const reply=chatGoalFailure(e);return {isError:true,content:[{type:"text" as const,text:JSON.stringify(reply)}],structuredContent:reply as unknown as Record<string,unknown>};};
  const requireChannel=(auth:unknown,id:string)=>{
    const identity=chatCardIdentity(auth);
    if(!cards.verified(identity,id))throw new Error("CARD_CHANNEL_REQUIRED: complete a fresh app acknowledgement before this Goal mutation.");
    return identity;
  };
  registerAppResource(server,"Chat Goal decision card",CHAT_GOAL_CARD_URI,{description:"Authenticated finite Goal business-choice card; not filesystem/process approval."},async(uri,extra)=>{
    chatCardIdentity(extra.authInfo);
    return {contents:[{uri:uri.href,mimeType:RESOURCE_MIME_TYPE,text:html,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};
  });
  registerAppTool(server,"chat_goal_card_connect",{outputSchema:chatGoalOutputSchemas.chat_goal_card_connect,title:"Check the Goal card return channel",description:"Before card-mode Goal creation, show a short-lived connection card with a fresh requestKey. Its UI acknowledges automatically; no user choice, Goal, permission, or model call is created. Call chat_goal_card_ready once with returned cardId. Do not claim tasks until channel_ready. Never use a diagnostic probe as approval.",inputSchema:{requestKey:chatGoalKey},annotations,_meta:viewMeta},async(args,extra)=>{chatGoalPhase("input_validated");
    try{return cards.connect(chatCardIdentity(extra.authInfo),args.requestKey);}catch(e){return failure(e);}
  });
  server.registerTool("chat_goal_card_ready",{outputSchema:chatGoalOutputSchemas.chat_goal_card_ready,title:"Wait once for card channel acknowledgement",description:"Wait once, at most 45 seconds, for the app-only acknowledgement. On channel_ready use cardId as cardChannelId. A receipt is valid for this verified OAuth client for 15 minutes, across MCP transports, not proof of a live/current Chat conversation. Timeout/disconnect means stop; never automatically retry or extend the wait.",inputSchema:{cardId:z.string().uuid()},annotations:{...annotations,idempotentHint:false},_meta:{securitySchemes}},async(args,extra)=>{chatGoalPhase("input_validated");
    try{return result(await cards.wait(chatCardIdentity(extra.authInfo),args.cardId,extra.signal));}catch(e){return failure(e);}
  });
  const presentation={workspaceId:z.string(),goalRef:chatGoalKey,cardChannelId:z.string().uuid()};
  registerAppTool(server,"chat_goal_ask_card",{outputSchema:chatGoalOutputSchemas.chat_goal_ask_card,title:"Ask a real Goal decision on a card",description:"Persist one non-sensitive business choice and show its card. Then call chat_goal_wait_decision once with cardId during the same active host request. Never answer for the user. Not for secrets, workspace access, process permissions, or changing acceptance criteria. Unsupported delivery/timeout leaves the decision pending. Reusing the request key shows history, never restarts a completed wait.",inputSchema:{...presentation,requestKey:chatGoalKey,expectedRevision:chatGoalRevision,...chatQuestionSchema.shape},annotations,_meta:viewMeta},async(args,extra)=>{chatGoalPhase("input_validated");
    try {
      const identity=requireChannel(extra.authInfo,args.cardChannelId),ctx=context(args.workspaceId,extra.authInfo);
      chatQuestionSchema.parse({question:args.question,choices:args.choices});
      const reply=await controller.ask(ctx,args);
      if(!reply.ok)return failure(new Error(reply.error!.message));
      return await cards.show(ctx,identity,args.goalRef,`ask:${args.requestKey}`);
    }catch(e){return failure(e);}
  });
  registerAppTool(server,"chat_goal_show_decision",{outputSchema:chatGoalOutputSchemas.chat_goal_show_decision,title:"Re-present an existing pending Goal decision",description:"Only on an explicit new user request after timeout/reconnect, read status and re-present the SAME pending decision with a fresh presentationKey. No new question or default answer is created; older cards are invalidated. Never call automatically to extend a wait. Expired decisions require explicit pause then ask again with a new request key.",inputSchema:{...presentation,presentationKey:chatGoalKey},annotations,_meta:viewMeta},async(args,extra)=>{chatGoalPhase("input_validated");
    try{return await cards.show(context(args.workspaceId,extra.authInfo),requireChannel(extra.authInfo,args.cardChannelId),args.goalRef,`show:${args.presentationKey}`);}catch(e){return failure(e);}
  });
  server.registerTool("chat_goal_wait_decision",{outputSchema:chatGoalOutputSchemas.chat_goal_wait_decision,title:"Wait once for the Goal card answer",description:"Wait at most 45 seconds for the returned cardId; never repeat a completed wait. Only answer_received/answer_already_recorded plus goal.state=ready allow the still-active Chat request to read status and claim its next task. Timeout, cancellation, disconnect or errors mean stop. Read status for durable recovery; never infer an ended Chat turn can be awakened.",inputSchema:{cardId:z.string().uuid()},annotations:{...annotations,idempotentHint:false},_meta:{securitySchemes}},async(args,extra)=>{chatGoalPhase("input_validated");
    try{return result(await cards.wait(chatCardIdentity(extra.authInfo),args.cardId,extra.signal));}catch(e){return failure(e);}
  });
  registerAppTool(server,"chat_goal_card_status",{outputSchema:chatGoalOutputSchemas.chat_goal_card_status,title:"Synchronize this Goal card",description:"App-only, token-protected card acknowledgement/status. No execution or model call. Does not extend deadlines or grant local permissions.",inputSchema:{cardId:z.string().uuid(),submitToken:z.string().length(64)},annotations,_meta:appMeta},async(args,extra)=>{chatGoalPhase("input_validated");
    try{return result(await cards.status(chatCardIdentity(extra.authInfo),args.cardId,args.submitToken));}catch(e){return failure(e);}
  });
  registerAppTool(server,"chat_goal_card_submit",{outputSchema:chatGoalOutputSchemas.chat_goal_card_submit,title:"Submit the user's Goal card choice",description:"App-only. Requires the secret delivered solely to this card, the verified OAuth client, current authorized workspace and a pending decision. Commits a displayed business choice or cancels; never grants filesystem/process rights. Late, stale, stopped or changed answers are rejected. No model may call this for the user.",inputSchema:{cardId:z.string().uuid(),submitToken:z.string().length(64),action:z.enum(["accept","cancel"]),answer:z.string().max(200).optional()},annotations,_meta:appMeta},async(args,extra)=>{chatGoalPhase("input_validated");
    try{return result(await cards.submit(chatCardIdentity(extra.authInfo),args.cardId,args.submitToken,args.action,args.answer));}catch(e){return failure(e);}
  });
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChatGoalController } from "./chat-goal-controller.js";
import { ChatGoalCards, CHAT_GOAL_CARD_URI } from "./chat-goal-cards.js";
import { registerChatGoalTools } from "./chat-goal-tools.js";
import { chatCardIdentity } from "./chat-goal-card-tools.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";

const auth={token:"test-only",clientId:"client-one",scopes:["devspace"],extra:{devspaceOwnerRef:"single-user"}};
const identity=chatCardIdentity(auth);
const body=(r:any)=>{assert.notEqual(r.isError,true,JSON.stringify(r));assert.equal(r.structuredContent.ok,true);return r.structuredContent.data;};
async function fixture(waitMs=1500){
  const root=await mkdtemp(join(process.env.DEVSPACE_CHAT_TEST_ROOT??tmpdir(),"goal-card-")),project=join(root,"project"),state=join(root,"state");
  const dataRoot=await mkdtemp(join(process.env.DEVSPACE_CHAT_TEST_DATA_ROOT??root,"card-")),dataDir=join(dataRoot,"seed");
  await mkdir(project);await mkdir(dataDir);
  const now=Date.now(),taskId=randomUUID();let offset=0,allowed=true,authorizeHook:(()=>Promise<void>)|undefined;
  const config={enabled:true,shrimpEntryPoint:join(root,"unused.js"),dataRoot};
  let controller=new ChatGoalController({stateDir:state,config,now:()=>Date.now()+offset});
  let cards=new ChatGoalCards(controller,{waitMs,now:()=>Date.now()+offset});
  const ctx={ownerRef:"single-user",workspaceRoot:project,authorize:async()=>{await authorizeHook?.();if(!allowed)throw new Error("WORKSPACE_ACCESS_REQUIRED: test access revoked");}};
  const task={id:taskId,name:"Task A",description:"Write the agreed test document.",status:"pending",dependencies:[],createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
  await writeFile(join(dataDir,"tasks.json"),JSON.stringify({tasks:[task]}));
  controller.store.prepare({goalRef:"chatgoal_card_test",ownerRef:"single-user",creationKey:"seed",workspaceRoot:process.platform==="win32"?project.toLowerCase():project,dataDir,revision:1,state:"ready",proofs:{},
    spec:{objective:"Test a real persisted business decision",successCriteria:"Verified choice and document",constraints:"No additional models",tasks:[{name:"Task A",description:task.description,implementationGuide:"Write A.md.",dependencies:[],checks:[{path:"A.md",contains:"Accepted"}]}]}});
  const id="chatgoal_card_test";
  return {root,project,ctx,id,get controller(){return controller;},get cards(){return cards;},
    current:()=>controller.store.get("single-user",id),advance:(ms:number)=>{offset+=ms;},revoke:()=>{allowed=false;},hook:(fn:()=>Promise<void>)=>{authorizeHook=fn;},
    ask:async(key="ask")=>{const r=await controller.ask(ctx,{goalRef:id,requestKey:key,expectedRevision:controller.store.get("single-user",id).revision,question:"Which accepted label should the report use?",choices:["BLUE","GREEN"]});assert.equal(r.ok,true,JSON.stringify(r));return r.data!;},
    show:async(key="present")=>{const r=await cards.show(ctx,identity,id,key);return {data:body(r),meta:r._meta!.goalCard as {cardId:string;submitToken:string}};},
    restart:async()=>{await cards.close();await controller.close();controller=new ChatGoalController({stateDir:state,config,now:()=>Date.now()+offset});cards=new ChatGoalCards(controller,{waitMs,now:()=>Date.now()+offset});},
    close:async()=>{await cards.close();await controller.close();}};
}
async function waitActive(f:Awaited<ReturnType<typeof fixture>>,meta:{cardId:string;submitToken:string}){
  for(let i=0;i<100;i++){const s=await f.cards.status(identity,meta.cardId,meta.submitToken);if(s.waitActive)return;await new Promise(r=>setTimeout(r,2));}
  throw new Error("wait did not start");
}

test("real Goal card: click during wait commits once, returns ready, and never starts a model",async()=>{
  const f=await fixture();try{
    await f.ask();const {meta}=await f.show();const waiting=f.cards.wait(identity,meta.cardId);await waitActive(f,meta);
    const accepted=await f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","BLUE");
    const result=await waiting;
    assert.equal(result.waitOutcome,"answer_received");assert.equal(result.receiptPhase,"during_wait");assert.equal(result.activeWaitAtSubmission,true);
    assert.equal(result.nextAction,"read_goal_status_then_continue_if_ready");
    assert.equal((result.goal as any).state,"ready");assert.equal(f.current().decision?.answer,"BLUE");assert.equal(result.additionalModelCalls,0);
    const revision=f.current().revision;
    assert.equal((await f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","BLUE")).replayed,true);
    await assert.rejects(()=>f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","GREEN"),/ANSWER_ALREADY_RECORDED/);
    assert.equal(f.current().revision,revision);assert.equal(accepted.canSubmit,false);
  }finally{await f.close();}
});
test("early choice is durable and consumed without another wait; cancellation pauses",async()=>{
  for(const action of ["accept","cancel"] as const){const f=await fixture();try{
    await f.ask();const {meta}=await f.show();await f.cards.submit(identity,meta.cardId,meta.submitToken,action,action==="accept"?"GREEN":undefined);
    const r=await f.cards.wait(identity,meta.cardId);assert.equal(r.waitOutcome,"answer_already_recorded");assert.equal(r.receiptPhase,"before_wait");
    assert.equal(f.current().state,action==="accept"?"ready":"paused");
  }finally{await f.close();}}
});
test("timeout cannot be renewed or accept late clicks; explicit re-presentation supersedes old token",async()=>{
  const f=await fixture(30);try{
    await f.ask();const first=await f.show();assert.equal((await f.cards.wait(identity,first.meta.cardId)).waitOutcome,"timeout");
    assert.equal((await f.cards.wait(identity,first.meta.cardId)).waitOutcome,"timeout");
    await assert.rejects(()=>f.cards.submit(identity,first.meta.cardId,first.meta.submitToken,"accept","BLUE"),/CARD_WAIT_ENDED/);
    assert.equal(f.current().state,"waiting_for_user");assert.equal(f.current().decision?.state,"pending");
    assert.equal((await f.show()).meta.cardId,first.meta.cardId);
    const second=await f.show("explicit-user-resume");assert.notEqual(second.meta.cardId,first.meta.cardId);
    await assert.rejects(()=>f.cards.submit(identity,first.meta.cardId,first.meta.submitToken,"accept","BLUE"),/CARD_WAIT_ENDED/);
    await f.cards.submit(identity,second.meta.cardId,second.meta.submitToken,"accept","BLUE");assert.equal(f.current().state,"ready");
  }finally{await f.close();}
});
test("disconnect/restart keeps decision pending; old tokens and connection receipts cannot survive restart",async()=>{
  const f=await fixture();try{
    const connected=f.cards.connect(identity,"connect"),c=connected._meta!.goalCard as any;
    await f.cards.status(identity,c.cardId,c.submitToken);assert.equal(f.cards.verified(identity,c.cardId),true);
    await f.ask();const first=await f.show();const abort=new AbortController(),waiting=f.cards.wait(identity,first.meta.cardId,abort.signal);
    await waitActive(f,first.meta);abort.abort();assert.equal((await waiting).waitOutcome,"transport_aborted");
    const decision=f.current().decision!.id;await f.restart();assert.equal(f.current().decision!.id,decision);assert.equal(f.current().decision!.state,"pending");
    assert.equal(f.cards.verified(identity,c.cardId),false);
    await assert.rejects(()=>f.cards.submit(identity,first.meta.cardId,first.meta.submitToken,"accept","BLUE"),/CARD_NOT_FOUND/);
    const second=await f.show("new-user-request");await f.cards.submit(identity,second.meta.cardId,second.meta.submitToken,"accept","BLUE");
    assert.equal(f.current().decision?.answer,"BLUE");
  }finally{await f.close();}
});
test("wrong owner, client, token, invalid choice, stopped goal and revoked workspace cannot grant a decision",async()=>{
  const f=await fixture();try{
    await f.ask();const {meta}=await f.show();
    await assert.rejects(()=>f.cards.submit("other",meta.cardId,meta.submitToken,"accept","BLUE"),/CARD_NOT_FOUND/);
    await assert.rejects(()=>f.cards.submit(identity,meta.cardId,"0".repeat(64),"accept","BLUE"),/INVALID_CARD_TOKEN/);
    await assert.rejects(()=>f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","RED"),/INVALID_DECISION/);
    await f.controller.control(f.ctx,{goalRef:f.id,requestKey:"stop",expectedRevision:f.current().revision,action:"stop"});
    await assert.rejects(()=>f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","BLUE"),/CARD_WAIT_ENDED/);
    assert.equal(f.current().state,"stopped");f.revoke();
    await assert.rejects(()=>f.cards.status(identity,meta.cardId,meta.submitToken),/WORKSPACE_ACCESS_REQUIRED/);
  }finally{await f.close();}
});
test("concurrent conflicting clicks never overwrite a choice; late authorization failure rolls back metadata",async()=>{
  const f=await fixture();try{
    await f.ask();const {meta}=await f.show();
    const both=await Promise.allSettled([f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","BLUE"),f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","GREEN")]);
    assert.equal(both.filter(r=>r.status==="fulfilled").length,1);
    const winner=both.findIndex(r=>r.status==="fulfilled");
    assert.equal(f.current().decision?.answer,["BLUE","GREEN"][winner]);
  }finally{await f.close();}
  const g=await fixture();try{
    await g.ask();const d=g.current().decision!,revision=g.current().revision;let checks=0;
    const ctx={...g.ctx,authorize:async()=>{if(++checks===2)throw new Error("WORKSPACE_ACCESS_REQUIRED: revoked at final authorization");}};
    const r=await g.controller.resolveDecision(ctx,g.id,d.id,{action:"accept",answer:"BLUE"});assert.equal(r.ok,false);
    assert.equal(g.current().state,"waiting_for_user");assert.equal(g.current().decision?.state,"pending");assert.equal(g.current().revision,revision);
  }finally{await g.close();}
});
test("expired connection/decision, clock crossing deadline and service close fail closed",async()=>{
  const f=await fixture();try{
    const r=f.cards.connect(identity,"connect"),c=r._meta!.goalCard as any;await f.cards.status(identity,c.cardId,c.submitToken);
    await f.ask();const {meta}=await f.show(),waiting=f.cards.wait(identity,meta.cardId);await waitActive(f,meta);
    f.advance(16*60_000);assert.equal(f.cards.verified(identity,c.cardId),false);
    await assert.rejects(()=>f.cards.submit(identity,meta.cardId,meta.submitToken,"accept","BLUE"),/CARD_WAIT_ENDED/);
    assert.equal((await waiting).waitOutcome,"timeout");assert.equal(f.current().decision?.state,"pending");
  }finally{await f.close();}
  const g=await fixture();try{await g.ask();const {meta}=await g.show(),waiting=g.cards.wait(identity,meta.cardId);await waitActive(g,meta);await g.cards.close();assert.equal((await waiting).waitOutcome,"service_closed");assert.equal(g.current().decision?.state,"pending");}finally{await g.close();}
});
test("protocol card handshake is app-secret protected, owner/client bound, and distinct from Goal permissions",async()=>{
  const f=await fixture(),server=new McpServer({name:"goal-card-test",version:"1"});
  registerChatGoalTools(server,f.controller,{getWorkspace:()=>({root:f.project})} as unknown as WorkspaceRegistry,{assertWorkspaceModifiable:()=>{}} as unknown as WorkspaceAccessManager,{service:f.cards,html:"<html>isolated fixture</html>",scope:"devspace"});
  const client=new Client({name:"deterministic MCP app test, not hosted Chat",version:"1"});
  const [s,c]=InMemoryTransport.createLinkedPair(),send=c.send.bind(c);c.send=(message,options)=>send(message,{...options,authInfo:auth});
  await server.connect(s);await client.connect(c);
  try{
    const tools=(await client.listTools()).tools;
    for(const name of ["chat_goal_card_submit","chat_goal_card_status"]){const t=tools.find(t=>t.name===name)!;assert.deepEqual((t._meta?.ui as any).visibility,["app"]);assert.equal((t._meta?.ui as any).resourceUri,undefined);}
    assert.equal((tools.find(t=>t.name==="chat_goal_ask_card")?._meta?.ui as any).resourceUri,CHAT_GOAL_CARD_URI);
    assert.equal(body(await client.callTool({name:"chat_goal_preflight",arguments:{}})).canCreateOrClaim,false);
    const forged=await client.callTool({name:"chat_goal_ask_card",arguments:{workspaceId:"workspace",goalRef:f.id,cardChannelId:randomUUID(),expectedRevision:1,requestKey:"forged-card-proof",question:"Select the label",choices:["BLUE","GREEN"]},_meta:{cardVerified:true}});
    assert.equal(forged.isError,true);assert.equal(f.current().revision,1);assert.equal(f.current().decision,undefined);
    const connected=await client.callTool({name:"chat_goal_card_connect",arguments:{requestKey:"new-handshake"}}),meta=connected._meta!.goalCard as any,id=body(connected).cardId;
    assert.ok(!JSON.stringify(connected.structuredContent).includes(meta.submitToken));assert.ok(!JSON.stringify(connected.content).includes(meta.submitToken));
    assert.equal(body(await client.callTool({name:"chat_goal_preflight",arguments:{cardChannelId:id}})).canCreateOrClaim,false);
    assert.equal((await client.callTool({name:"chat_goal_card_status",arguments:{cardId:id,submitToken:"0".repeat(64)}})).isError,true);
    await client.callTool({name:"chat_goal_card_status",arguments:{cardId:id,submitToken:meta.submitToken}});
    assert.equal(body(await client.callTool({name:"chat_goal_card_ready",arguments:{cardId:id}})).waitOutcome,"channel_ready");
    assert.equal(f.cards.verified(chatCardIdentity({...auth,clientId:"different"}),id),false);
    assert.equal(body(await client.callTool({name:"chat_goal_preflight",arguments:{cardChannelId:id}})).status,"card_transport_verified");
    const shown=await client.callTool({name:"chat_goal_ask_card",arguments:{workspaceId:"workspace",goalRef:f.id,cardChannelId:id,expectedRevision:1,requestKey:"real-question",question:"Select the label",choices:["BLUE","GREEN"]}}),m=shown._meta!.goalCard as any;
    const pending=client.callTool({name:"chat_goal_wait_decision",arguments:{cardId:m.cardId}});await waitActive(f,m);
    await client.callTool({name:"chat_goal_card_submit",arguments:{cardId:m.cardId,submitToken:m.submitToken,action:"accept",answer:"BLUE"}});
    assert.equal(body(await pending).waitOutcome,"answer_received");assert.equal(f.current().decision?.answer,"BLUE");
  }finally{await client.close();await server.close();await f.close();}
});
test("business card uses safe DOM text, app-only calls, and has no model or follow-up API",async()=>{
  for(const file of ["src/chat-goal-cards.ts","src/chat-goal-card-tools.ts","scripts/goal-card/card.ts"]){const source=await readFile(file,"utf8");
    assert.doesNotMatch(source,/from\s+["'][^"']*(?:local-agent|openai|anthropic|codex)[^"']*["']/);
    assert.doesNotMatch(source,/sendFollowUpMessage|sampling\/createMessage|create_thread|setNativeGoal|innerHTML|sendMessage/);
  }
});

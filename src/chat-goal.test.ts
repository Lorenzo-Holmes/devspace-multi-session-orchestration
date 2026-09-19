import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chatGoalSpecSchema, type ChatGoalSpec } from "./chat-goal-contracts.js";
import { ChatGoalController } from "./chat-goal-controller.js";
import { ChatGoalStore, type ChatGoalBinding, type ChatReply } from "./chat-goal-store.js";
import { registerChatGoalTools } from "./chat-goal-tools.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import { GoalBindingStore } from "./goal-binding-store.js";

const spec = ():ChatGoalSpec => ({objective:"Create a checked three-part document",successCriteria:"All three documents contain their agreed acceptance text",constraints:"No additional models or external services",tasks:["A","B","C"].map((name,i)=>({name:`Task ${name}`,description:`Create document ${name} with the agreed acceptance content.`,implementationGuide:`Write ${name}.md and read the real output.`,dependencies:i?[`Task ${String.fromCharCode(64+i)}`]:[],checks:[{path:`${name}.md`,contains:`Accepted ${name}`}]}))});
const rootForTests=process.env.DEVSPACE_CHAT_TEST_ROOT??tmpdir();
const shrimpEntry=process.env.DEVSPACE_CHAT_TEST_SHRIMP_ENTRY;
const shrimpDataRoot=process.env.DEVSPACE_CHAT_TEST_DATA_ROOT;
const ok=(reply:ChatReply):any=>{assert.equal(reply.ok,true,JSON.stringify(reply));return reply.data;};
async function fixture() {
  await mkdir(rootForTests,{recursive:true});
  const root=await mkdtemp(join(rootForTests,"chat-goal-")),project=join(root,"project"),state=join(root,"controller");
  await mkdir(project);
  const base=shrimpDataRoot??join(root,"data");await mkdir(base,{recursive:true});
  const dataRoot=await mkdtemp(join(base,"run-"));
  let authorized=true,now=Date.now();
  const options={stateDir:state,config:{enabled:true,shrimpEntryPoint:shrimpEntry??join(root,"unused-shrimp.js"),dataRoot},now:()=>now};
  const context={ownerRef:"single-user",workspaceRoot:project,authorize:async()=>{if(!authorized)throw new Error("WORKSPACE_ACCESS_REQUIRED: test root revoked");}};
  return {root,project,state,options,context,revoke:()=>{authorized=false;},advance:(ms:number)=>{now+=ms;}};
}
function seed(f:Awaited<ReturnType<typeof fixture>>,controller:ChatGoalController):ChatGoalBinding {
  return controller.store.prepare({goalRef:"chatgoal_test",ownerRef:"single-user",workspaceRoot:process.platform==="win32"?f.project.toLowerCase():f.project,
    dataDir:join(f.options.config.dataRoot,"seed"),creationKey:"seed",spec:spec(),revision:1,state:"ready",proofs:{}});
}

test("Chat contract rejects unsafe paths, placeholders, duplicate tasks and invalid dependency graphs",()=>{
  assert.equal(chatGoalSpecSchema.safeParse(spec()).success,true);
  const bad=spec();bad.tasks[0].dependencies=["unknown"];assert.equal(chatGoalSpecSchema.safeParse(bad).success,false);
  bad.tasks[0].dependencies=["Task C"];assert.equal(chatGoalSpecSchema.safeParse(bad).success,false);
  const duplicate=spec();duplicate.tasks[1].name="Task A";assert.equal(chatGoalSpecSchema.safeParse(duplicate).success,false);
  for (const path of ["../secret","D:\\other\\private.txt","alias:stream",".git/config"]) {
    const v=spec();v.tasks[0].checks=[{path}];assert.equal(chatGoalSpecSchema.safeParse(v).success,false);
  }
  assert.equal(chatGoalSpecSchema.safeParse({...spec(),objective:"【在这里填写目标】"}).success,false);
  assert.equal(chatGoalSpecSchema.safeParse({...spec(),executor:"codex"}).success,false);
});

test("request journal fences concurrent writers, changed retries and interrupted operations across restart",async()=>{
  const f=await fixture();let controller=new ChatGoalController(f.options);
  try {
    const b=seed(f,controller),store=controller.store;
    store.begin(b.ownerRef,b.goalRef,"in-flight","fingerprint",1);
    assert.throws(()=>store.begin(b.ownerRef,b.goalRef,"other","other",1),/RECONCILIATION_REQUIRED/);
    assert.throws(()=>store.begin(b.ownerRef,b.goalRef,"in-flight","changed",1),/REQUEST_KEY_CONFLICT/);
    await controller.close();controller=new ChatGoalController(f.options);
    assert.throws(()=>controller.store.begin(b.ownerRef,b.goalRef,"in-flight","fingerprint",1),/RECONCILIATION_REQUIRED/);
    assert.throws(()=>controller.store.get("other-user",b.goalRef),/NOT_FOUND/);
    const native=new GoalBindingStore(f.state);
    try {assert.throws(()=>native.prepare({ownerRef:"single-user",workspaceRoot:f.project,dataDir:join(f.root,"native-data"),requestKey:"native"}),/GOAL_BUSY/);} finally {native.close();}
  }finally{await controller.close();}
});

test("ten host-visible tools contain no native executor, describe task leasing as local state only, and reject spoofed identity",async()=>{
  const f=await fixture(),controller=new ChatGoalController(f.options),server=new McpServer({name:"chat-entry",version:"1"}),client=new Client({name:"test",version:"1"});
  registerChatGoalTools(server,controller,{} as WorkspaceRegistry,{} as WorkspaceAccessManager);
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try {
    const listed=(await client.listTools()).tools;
    assert.deepEqual(listed.map(t=>t.name).sort(),["chat_goal_preflight","chat_goal_create","chat_goal_status","chat_goal_status_by_path","chat_goal_next","chat_goal_complete","chat_goal_handoff","chat_goal_resume","chat_goal_control","chat_goal_ask"].sort());
    assert.ok(listed.every(t=>!Object.keys(t.inputSchema.properties??{}).some(k=>["ownerRef","codexCommand","dataDir","approvalToken"].includes(k))));
    const preflight=listed.find(t=>t.name==="chat_goal_preflight")!;
    assert.deepEqual(Object.keys(preflight.inputSchema.properties??{}),["cardChannelId"]);
    assert.equal(preflight.annotations?.readOnlyHint,true);
    const next=listed.find(t=>t.name==="chat_goal_next")!;
    assert.equal(next.annotations?.readOnlyHint,false);
    assert.equal(next.annotations?.destructiveHint,false);
    assert.equal(next.annotations?.openWorldHint,false);
    assert.match(next.title??"",/local Chat Goal task state/i);
    assert.match(next.description??"",/does not execute the task/i);
    assert.match(next.description??"",/not a credential or permission/i);
    const nextProperties=(next.inputSchema.properties??{}) as Record<string,{description?:string}>;
    assert.match(nextProperties.leaseToken?.description??"",/not an authentication credential/i);
    assert.match(nextProperties.cardChannelId?.description??"",/not a filesystem\/process permission/i);
    const unauthenticated=await client.callTool({name:"chat_goal_preflight",arguments:{},_meta:{devspaceOwnerRef:"single-user"}});
    assert.equal(unauthenticated.isError,true);assert.match(JSON.stringify(unauthenticated),/AUTHENTICATION_REQUIRED/);
    const r=await client.callTool({name:"chat_goal_status",arguments:{workspaceId:"fake"},_meta:{devspaceOwnerRef:"single-user"}});
    assert.equal(r.isError,true);assert.match(JSON.stringify(r),/AUTHENTICATION_REQUIRED/);
  }finally{await client.close();await server.close();await controller.close();}
});

async function protocolFixture(supportsForm:boolean|"legacy"|"url_only") {
  const f=await fixture(),controller=new ChatGoalController(f.options),binding=seed(f,controller);
  const server=new McpServer({name:"chat-form",version:"1"});
  registerChatGoalTools(server,controller,{getWorkspace:()=>({root:f.project})} as unknown as WorkspaceRegistry,{
    assertWorkspaceModifiable:()=>{},
    authorizeWorkspacePath:async(path:string)=>({path}),
  } as unknown as WorkspaceAccessManager);
  const capabilities=supportsForm==="legacy"?{elicitation:{}}:supportsForm==="url_only"?{elicitation:{url:{}}}:supportsForm?{elicitation:{form:{}}}:{};
  const client=new Client({name:"deterministic test client, not ChatGPT",version:"1"},{capabilities});
  const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
  const original=clientSide.send.bind(clientSide);
  clientSide.send=(message,options)=>original(message,{...options,authInfo:{token:"test-only",clientId:"test-client",scopes:["devspace"],extra:{devspaceOwnerRef:"single-user"}}});
  await server.connect(serverSide);await client.connect(clientSide);
  return {...f,controller,binding,server,client,close:async()=>{await client.close();await server.close();await controller.close();}};
}

test("status by path is read-only and bypasses workspace creation",async()=>{
  const f=await fixture(),controller=new ChatGoalController(f.options),binding=seed(f,controller);
  const server=new McpServer({name:"chat-path-status",version:"1"});
  let workspaceLookups=0,authorizations=0;
  registerChatGoalTools(server,controller,{
    getWorkspace:()=>{workspaceLookups++;throw new Error("workspace lookup must not occur");},
  } as unknown as WorkspaceRegistry,{
    authorizeWorkspacePath:async(path:string,_scope:string|undefined,required:"read"|"modify")=>{
      authorizations++;
      assert.equal(required,"read");
      return {path};
    },
  } as unknown as WorkspaceAccessManager);
  const client=new Client({name:"test",version:"1"});
  const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
  const original=clientSide.send.bind(clientSide);
  clientSide.send=(message,options)=>original(message,{...options,authInfo:{token:"test-only",clientId:"test-client",scopes:["devspace"],extra:{devspaceOwnerRef:"single-user"}}});
  await server.connect(serverSide);await client.connect(clientSide);
  try {
    const before=controller.store.get("single-user",binding.goalRef);
    const result=await client.callTool({name:"chat_goal_status_by_path",arguments:{path:f.project,goalRef:binding.goalRef}});
    const data=ok(result.structuredContent as unknown as ChatReply);
    const after=controller.store.get("single-user",binding.goalRef);
    assert.equal(data.goalRef,binding.goalRef);
    assert.equal(data.revision,before.revision);
    assert.equal(after.revision,before.revision);
    assert.deepEqual(after.lease,before.lease);
    assert.deepEqual(after.decision,before.decision);
    assert.equal(workspaceLookups,0);
    assert.equal(authorizations,2);
  } finally {await client.close();await server.close();await controller.close();}
});

async function goalMutationSnapshot(f:Awaited<ReturnType<typeof protocolFixture>>) {
  return {
    bindings:f.controller.store.database.sqlite.prepare("select * from chat_goal_bindings order by goal_ref").all(),
    journal:f.controller.store.database.sqlite.prepare("select * from chat_goal_requests order by owner_ref,request_key").all(),
    projectEntries:(await readdir(f.project,{recursive:true})).sort(),
    dataEntries:(await readdir(f.options.config.dataRoot,{recursive:true})).sort(),
  };
}

test("preflight is authenticated, read-only, workspace-free and reports only negotiated capability",async()=>{
  for (const mode of [false,"url_only",true,"legacy"] as const) {
    const f=await protocolFixture(mode);
    let prompts=0;
    if(mode!==false) f.client.setRequestHandler(ElicitRequestSchema,async()=>{prompts++;return {action:"cancel"};});
    try {
      const before=await goalMutationSnapshot(f);
      const result=await f.client.callTool({name:"chat_goal_preflight",arguments:{}});
      const data=ok(result.structuredContent as unknown as ChatReply),declared=mode===true||mode==="legacy";
      assert.equal(data.canCreateOrClaim,declared);
      assert.equal(data.status,declared?"capability_declared":"blocked");
      assert.equal(data.formCapability,declared?"declared":"not_declared");
      assert.equal(data.checkScope,"current_mcp_connection");assert.equal(data.policy,"form_required");
      assert.equal(data.formDelivery,"unverified");assert.equal(data.sameTurnContinuation,"unverified");
      assert.equal(data.permissionCardSupport,"not_checked");assert.equal(data.chatUsageAccounting,"unknown_host_controlled");
      assert.equal(data.hostTurnState,"not_observable");assert.equal(data.canWakeEndedHostTurn,false);
      assert.equal(data.additionalModelCalls,0);assert.equal(prompts,0);
      assert.deepEqual(await goalMutationSnapshot(f),before);
    } finally {await f.close();}
  }
});

test("missing and URL-only form support block direct create, claim and renewal without Goal effects",async()=>{
  for(const mode of [false,"url_only"] as const) {
    const f=await protocolFixture(mode);
    try {
      const before=await goalMutationSnapshot(f);
      // No preflight call precedes this direct create. An untrusted argument/meta
      // cannot override the negotiated capability, even if the host passes it on.
      const createArgs={workspaceId:"workspace",requestKey:"blocked-create",spec:spec(),capabilities:{elicitation:{form:{}}}};
      for(let attempt=0;attempt<2;attempt++) {
        const result=await f.client.callTool({name:"chat_goal_create",arguments:createArgs,_meta:{preflightPassed:true}});
        const reply=result.structuredContent as unknown as ChatReply;
        assert.equal(result.isError,true,JSON.stringify(result));assert.equal(reply.error?.code,"HOST_FORM_UNSUPPORTED");
        assert.equal(reply.data?.goalMutationAttempted,false);
      }
      for(const leaseToken of [undefined,"00000000-0000-4000-8000-000000000001"]) {
        const result=await f.client.callTool({name:"chat_goal_next",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"blocked-claim",...(leaseToken?{leaseToken}:{})}});
        assert.equal((result.structuredContent as unknown as ChatReply).error?.code,"HOST_FORM_UNSUPPORTED");
      }
      assert.deepEqual(await goalMutationSnapshot(f),before);
      // Existing state remains readable and stoppable, rather than being reset
      // or silently resumed to disguise the incompatible connection.
      const status=await f.client.callTool({name:"chat_goal_status",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef}});
      assert.equal(ok(status.structuredContent as unknown as ChatReply).revision,1);
      const stopped=await f.client.callTool({name:"chat_goal_control",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"explicit-stop",action:"stop"}});
      assert.equal(ok(stopped.structuredContent as unknown as ChatReply).state,"stopped");
    } finally {await f.close();}
  }
});

test("supported MCP form returns user choice to the original tools/call without a follow-up message",async()=>{
  const f=await protocolFixture(true);
  let prompts=0;
  f.client.setRequestHandler(ElicitRequestSchema,async request=>{prompts++;assert.equal(request.params.mode,"form");return {action:"accept",content:{answer:"Markdown"}};});
  try {
    const result=await f.client.callTool({name:"chat_goal_ask",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"question",question:"Which document format?",choices:["Markdown","Text"]}});
    assert.equal(result.isError,false,JSON.stringify(result));
    const data=ok(result.structuredContent as unknown as ChatReply);
    assert.equal(prompts,1);assert.equal(data.state,"ready");assert.equal(data.decision.answer,"Markdown");
    assert.equal(data.hostTurnState,"not_observable");assert.equal(data.additionalModelCalls,0);
    const repeat=await f.client.callTool({name:"chat_goal_ask",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"question",question:"Which document format?",choices:["Markdown","Text"]}});
    assert.equal(repeat.isError,false);assert.equal(prompts,1);
  }finally{await f.close();}
});

test("legacy empty elicitation capability is normalized by the official SDK and still opens the form",async()=>{
  const f=await protocolFixture("legacy");let prompts=0;
  f.client.setRequestHandler(ElicitRequestSchema,async()=>{prompts++;return {action:"accept",content:{answer:"Markdown"}};});
  try {
    assert.deepEqual(f.server.server.getClientCapabilities()?.elicitation?.form,{});
    const result=await f.client.callTool({name:"chat_goal_ask",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"legacy-form",question:"Which document format?",choices:["Markdown","Text"]}});
    const data=ok(result.structuredContent as unknown as ChatReply);
    assert.equal(prompts,1);assert.equal(data.state,"ready");assert.equal(data.decision.answer,"Markdown");
  }finally{await f.close();}
});

test("unsupported form keeps the decision pending and resume cannot silently approve it",async()=>{
  const f=await protocolFixture(false);
  try {
    const result=await f.client.callTool({name:"chat_goal_ask",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"question",question:"Which document format?",choices:["Markdown","Text"]}});
    const data=ok(result.structuredContent as unknown as ChatReply);
    assert.equal(data.state,"waiting_for_user");assert.equal(data.interaction.status,"host_form_unsupported");
    const before=await goalMutationSnapshot(f);
    const preflight=await f.client.callTool({name:"chat_goal_preflight",arguments:{}});
    assert.equal(ok(preflight.structuredContent as unknown as ChatReply).canCreateOrClaim,false);
    assert.deepEqual(await goalMutationSnapshot(f),before);
    const resume=await f.controller.control(f.context,{goalRef:f.binding.goalRef,expectedRevision:data.revision,requestKey:"resume",action:"resume"});
    assert.equal(resume.ok,false);assert.equal(f.controller.store.get("single-user",f.binding.goalRef).decision?.state,"pending");
  }finally{await f.close();}
});

test("late form result cannot resume a stopped goal; expired decisions reject late acceptance",async()=>{
  const f=await fixture(),controller=new ChatGoalController(f.options),b=seed(f,controller);
  try {
    const asked=ok(await controller.ask(f.context,{goalRef:b.goalRef,expectedRevision:1,requestKey:"ask",question:"Which format?",choices:["Markdown","Text"]}));
    f.advance(11*60_000);
    assert.equal((await controller.resolveDecision(f.context,b.goalRef,asked.decision.id,{action:"accept",answer:"Markdown"})).ok,false);
    const current=controller.store.get("single-user",b.goalRef);
    const stop=ok(await controller.control(f.context,{goalRef:b.goalRef,expectedRevision:current.revision,requestKey:"stop",action:"stop"}));
    assert.equal(stop.state,"stopped");
    assert.equal((await controller.resolveDecision(f.context,b.goalRef,asked.decision.id,{action:"accept",answer:"Markdown"})).ok,false);
    assert.equal((await controller.control(f.context,{goalRef:b.goalRef,expectedRevision:stop.revision,requestKey:"restart",action:"resume"})).ok,false);
  }finally{await controller.close();}
});

test("form transport error persists a pending decision, without accepting a default",async()=>{
  const f=await protocolFixture(true);
  f.client.setRequestHandler(ElicitRequestSchema,async()=>{throw new Error("Simulated host form transport failure");});
  try {
    const preflight=ok((await f.client.callTool({name:"chat_goal_preflight",arguments:{}})).structuredContent as unknown as ChatReply);
    assert.equal(preflight.canCreateOrClaim,true);assert.equal(preflight.formDelivery,"unverified");
    const result=await f.client.callTool({name:"chat_goal_ask",arguments:{workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"ask-error",question:"Which format?",choices:["Markdown","Text"]}});
    const data=ok(result.structuredContent as unknown as ChatReply);
    assert.equal(data.interaction.status,"pending_after_transport_or_timeout");assert.equal(data.decision.state,"pending");assert.equal(data.state,"waiting_for_user");
  }finally{await f.close();}
});

test("duplicate question requests do not create two simultaneous forms",async()=>{
  const f=await protocolFixture(true);
  let release!:()=>void,opened!:()=>void,prompts=0;
  const gate=new Promise<void>(r=>{release=r;}),seen=new Promise<void>(r=>{opened=r;});
  f.client.setRequestHandler(ElicitRequestSchema,async()=>{prompts++;opened();await gate;return {action:"accept",content:{answer:"Markdown"}};});
  const args={workspaceId:"workspace",goalRef:f.binding.goalRef,expectedRevision:1,requestKey:"concurrent-question",question:"Which format?",choices:["Markdown","Text"]};
  try {
    const first=f.client.callTool({name:"chat_goal_ask",arguments:args});await seen;
    const second=await f.client.callTool({name:"chat_goal_ask",arguments:args});
    assert.equal(ok(second.structuredContent as unknown as ChatReply).interaction.status,"question_already_open");
    release();assert.equal((await first).isError,false);assert.equal(prompts,1);
  }finally{release();await f.close();}
});

test("pause invalidates a pending form; resume cannot invent the missing user answer",async()=>{
  const f=await fixture(),controller=new ChatGoalController(f.options),b=seed(f,controller);
  try {
    const asked=ok(await controller.ask(f.context,{goalRef:b.goalRef,expectedRevision:1,requestKey:"ask",question:"Which format?",choices:["Markdown","Text"]}));
    const paused=ok(await controller.control(f.context,{goalRef:b.goalRef,expectedRevision:asked.revision,requestKey:"pause",action:"pause"}));
    assert.equal((await controller.resolveDecision(f.context,b.goalRef,asked.decision.id,{action:"accept",answer:"Markdown"})).ok,false);
    assert.equal((await controller.control(f.context,{goalRef:b.goalRef,expectedRevision:paused.revision,requestKey:"resume",action:"resume"})).ok,false);
    const reopened=ok(await controller.ask(f.context,{goalRef:b.goalRef,expectedRevision:paused.revision,requestKey:"ask-new",question:"Which format now?",choices:["Markdown","Text"]}));
    assert.notEqual(reopened.decision.id,asked.decision.id);
    assert.equal(ok(await controller.resolveDecision(f.context,b.goalRef,reopened.decision.id,{action:"accept",answer:"Text"})).state,"ready");
  }finally{await controller.close();}
});

test("turn handoff resumes the exact existing lease without claiming a second task",async()=>{
  const f=await fixture(),controller=new ChatGoalController(f.options),b=seed(f,controller);
  try {
    // Seed an owned in-progress lease without invoking Shrimp; this test is for
    // DevSpace handoff semantics only.
    const current=controller.store.get("single-user",b.goalRef);
    current.lease={taskId:"00000000-0000-4000-8000-000000000001",token:"00000000-0000-4000-8000-000000000002",expiresAt:Date.now()+60_000};
    controller.store.database.sqlite.prepare("update chat_goal_bindings set metadata_json=? where goal_ref=?").run(JSON.stringify(current),b.goalRef);
    const originalTasks=(controller as any).tasks.bind(controller);
    (controller as any).tasks=async()=>({hash:"test",commit:null,tasks:[{id:current.lease!.taskId,name:"Task A",status:"in_progress",dependencies:[],description:"A",createdAt:"now",updatedAt:"now"}]});
    const handed=ok(await controller.handoff(f.context,{goalRef:b.goalRef,requestKey:"handoff",expectedRevision:1}));
    assert.equal(handed.nextAction,"resume_handoff");assert.equal(handed.handoff.state,"pending");
    const token=current.lease.token;
    f.advance(11*60_000);
    const resumed=ok(await controller.resume(f.context,{goalRef:b.goalRef,requestKey:"resume-handoff",expectedRevision:handed.revision,handoffId:handed.handoff.id}));
    assert.equal(resumed.handoff.state,"consumed");assert.equal(resumed.nextAction,"execute_claimed_task");assert.equal(resumed.lease.token,token);
    assert.ok(resumed.lease.expiresAt>Date.now());
    assert.equal((await controller.resume(f.context,{goalRef:b.goalRef,requestKey:"resume-again",expectedRevision:resumed.revision,handoffId:handed.handoff.id})).ok,false);
    (controller as any).tasks=originalTasks;
  }finally{await controller.close();}
});

test("turn handoff without a lease resumes to the same pending successor without claiming it",async()=>{
  const f=await fixture(),controller=new ChatGoalController(f.options),b=seed(f,controller);
  try {
    const task={id:"00000000-0000-4000-8000-000000000011",name:"Task A",status:"pending",dependencies:[],description:"A",createdAt:"now",updatedAt:"now"};
    const originalTasks=(controller as any).tasks.bind(controller);
    (controller as any).tasks=async()=>({hash:"test",commit:null,tasks:[task]});
    const handed=ok(await controller.handoff(f.context,{goalRef:b.goalRef,requestKey:"handoff-pending",expectedRevision:1}));
    const resumed=ok(await controller.resume(f.context,{goalRef:b.goalRef,requestKey:"resume-pending",expectedRevision:handed.revision,handoffId:handed.handoff.id}));
    assert.equal(resumed.handoff.state,"consumed");assert.equal(resumed.lease,null);assert.equal(resumed.nextAction,"claim_next_task");assert.equal(resumed.nextTask.id,task.id);
    (controller as any).tasks=originalTasks;
  }finally{await controller.close();}
});

test("original Shrimp MCP: A-B-C, real checks, replay, restart, stale lease, final recheck and stop",{skip:!shrimpEntry||!shrimpDataRoot},async()=>{
  const f=await fixture();let controller=new ChatGoalController(f.options);
  try {
    let result=ok(await controller.create(f.context,"create",spec()));
    const id=result.goalRef;assert.equal(result.tasks.length,3);assert.equal(result.nextTask.name,"Task A");
    assert.equal((await controller.create(f.context,"create",spec())).replayed,true);
    assert.equal((await controller.create(f.context,"create",{...spec(),objective:"Changed objective"})).ok,false);
    const first=ok(await controller.next(f.context,{goalRef:id,requestKey:"claim-a",expectedRevision:result.revision}));
    const duplicate=await controller.next(f.context,{goalRef:id,requestKey:"claim-a",expectedRevision:result.revision});assert.equal(duplicate.replayed,true);
    assert.equal((await controller.next(f.context,{goalRef:id,requestKey:"steal-a",expectedRevision:first.revision})).ok,false);
    await writeFile(join(f.project,"A.md"),"Wrong content\n");
    assert.equal((await controller.complete(f.context,{goalRef:id,requestKey:"bad-a",expectedRevision:first.revision,taskId:first.lease.taskId,leaseToken:first.lease.token,assessment:"The completed artifact is checked against the agreed content."})).ok,false);
    await writeFile(join(f.project,"A.md"),"Accepted A\n");
    const completeArgs={goalRef:id,requestKey:"complete-a",expectedRevision:first.revision,taskId:first.lease.taskId,leaseToken:first.lease.token,assessment:"The completed artifact is checked against the agreed content."};
    result=ok(await controller.complete(f.context,completeArgs));assert.equal(result.tasks[0].status,"completed");assert.equal(result.nextTask.name,"Task B");
    assert.equal((await controller.complete(f.context,completeArgs)).replayed,true);
    const hashA=result.proofs[first.lease.taskId].artifacts[0].sha256;
    await controller.close();controller=new ChatGoalController(f.options);
    result=ok(await controller.status(f.context,id));assert.equal(result.nextTask.name,"Task B");assert.equal(result.proofs[first.lease.taskId].artifacts[0].sha256,hashA);
    for (const name of ["B","C"]) {
      let claimed=ok(await controller.next(f.context,{goalRef:id,requestKey:`claim-${name}`,expectedRevision:result.revision}));
      assert.equal(claimed.nextTask.name,`Task ${name}`);
      if (name==="B") {
        f.advance(11*60_000);
        assert.equal((await controller.complete(f.context,{goalRef:id,requestKey:"expired",expectedRevision:claimed.revision,taskId:claimed.lease.taskId,leaseToken:claimed.lease.token,assessment:"The completed artifact is checked against the agreed content."})).ok,false);
        claimed=ok(await controller.next(f.context,{goalRef:id,requestKey:"renew-b",expectedRevision:claimed.revision,leaseToken:claimed.lease.token}));
      }
      await writeFile(join(f.project,`${name}.md`),`Accepted ${name}\n`);
      if (name==="C") {
        await writeFile(join(f.project,"A.md"),"Regressed A\n");
        assert.equal((await controller.complete(f.context,{goalRef:id,requestKey:"regression",expectedRevision:claimed.revision,taskId:claimed.lease.taskId,leaseToken:claimed.lease.token,assessment:"The completed artifact is checked against the agreed content."})).ok,false);
        await writeFile(join(f.project,"A.md"),"Accepted A\n");
      }
      result=ok(await controller.complete(f.context,{goalRef:id,requestKey:`complete-${name}`,expectedRevision:claimed.revision,taskId:claimed.lease.taskId,leaseToken:claimed.lease.token,assessment:"The completed artifact is checked against the agreed content."}));
    }
    assert.equal(result.state,"completed");assert.equal(result.nextAction,"stop");assert.ok(result.tasks.every((t:any)=>t.status==="completed"));assert.ok(result.taskCommit);
    assert.equal((await controller.next(f.context,{goalRef:id,requestKey:"repeat-done",expectedRevision:result.revision})).ok,false);
    await controller.close();controller=new ChatGoalController(f.options);assert.equal(ok(await controller.status(f.context,id)).nextAction,"stop");
    f.revoke();assert.equal((await controller.status(f.context,id)).ok,false);
    await writeFile(join(f.root,"LOCAL-ACCEPTANCE.json"),JSON.stringify({scope:"original Shrimp over SDK MCP, deterministic caller; NOT hosted Chat acceptance",...result},null,2));
    console.log(`Chat Goal local evidence: ${join(f.root,"LOCAL-ACCEPTANCE.json")}`);
  }finally{await controller.close();}
});

test("Chat implementation has no model runtime imports or message-triggering API",async()=>{
  for(const file of ["chat-goal-controller.ts","chat-goal-tools.ts","chat-goal-store.ts","chat-goal-preflight.ts"]){
    const source=await readFile(new URL(file,import.meta.url),"utf8");
    assert.doesNotMatch(source,/from\s+["'][^"']*(?:local-agent|openai|anthropic|codex)[^"']*["']/);
    assert.doesNotMatch(source,/sendFollowUpMessage|sampling\/createMessage|create_thread|setNativeGoal/);
  }
});

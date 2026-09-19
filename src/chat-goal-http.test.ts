import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { chatGoalOutputSchemas, type ChatGoalToolName } from "./chat-goal-output.js";
import type { createServer as CreateServer } from "./server.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const testRoot=process.env.DEVSPACE_CHAT_TEST_ROOT,dataBase=process.env.DEVSPACE_CHAT_TEST_DATA_ROOT,shrimpEntry=process.env.DEVSPACE_CHAT_TEST_SHRIMP_ENTRY;
for(const interaction of ["form","card"] as const)test(`isolated authenticated HTTP entry: task chain, reconnect and bounded ${interaction}`,{skip:!testRoot||!dataBase||!shrimpEntry,timeout:120000},async(t)=>{
  const createServer:typeof CreateServer=(await import(process.env.DEVSPACE_GOAL_CARD_TEST_SERVER_ENTRY??(process.env.DEVSPACE_CHAT_TEST_DIST==="1"?"../dist/server.js":"./server.js"))).createServer;
  await mkdir(testRoot!,{recursive:true});await mkdir(dataBase!,{recursive:true});
  const root=await mkdtemp(join(testRoot!,"chat-http-")),dataRoot=await mkdtemp(join(dataBase!,"http-"));
  const project=join(root,"project");await mkdir(project);
  const events:Record<string,unknown>[]=[];
  const traces:Record<string,unknown>[]=[];
  const print=console.log.bind(console);
  t.mock.method(console,"log",(...args:unknown[])=>{
    if(typeof args[0]==="string"&&args[0].startsWith("{"))try {
      const value=JSON.parse(args[0]);if(value.event==="chat_goal_call")traces.push(value);return;
    }catch{/* Non-JSON test output is not a diagnostic record. */}
    print(...args);
  });
  let service:ReturnType<typeof createServer>|undefined,http:Server|undefined,client:Client|undefined,appClient:Client|undefined,cardChannelId:string|undefined;
  const configDir=join(root,"config"),stateDir=join(root,"state");
  let workspaceId="",goalRef:string,origin:string,env:NodeJS.ProcessEnv;
  const note=(event:string,data:unknown)=>{events.push({event,at:new Date().toISOString(),data});};
  const contract={objective:"Build and verify a tiny addition module",successCriteria:"Technical notes, working addition module, and a passing test report",constraints:"Use only this project; no other models or services",tasks:[
    {name:"Task A",description:"Write the technical notes documenting the addition behavior.",implementationGuide:"Create TECH.md describing add(2, 3) returning 5.",dependencies:[],checks:[{path:"TECH.md",contains:"add(2, 3) = 5"}]},
    {name:"Task B",description:"Implement the pure addition function in an ES module.",implementationGuide:"Create app.mjs exporting add(a, b).",dependencies:["Task A"],checks:[{path:"app.mjs",contains:"export function add"}]},
    {name:"Task C",description:"Execute the actual module assertion and record a test report.",implementationGuide:"Run a Node assertion through DevSpace and write TEST.md after exit zero.",dependencies:["Task B"],checks:[{path:"TEST.md",contains:"PASS: add(2, 3) = 5"}]},
  ]};
  async function start() {
    // Bind port 0 atomically. Never stop or occupy an existing service's port.
    http=createHttpServer();await new Promise<void>((r,j)=>{http!.once("error",j);http!.listen(0,"127.0.0.1",r);});
    const port=(http.address() as {port:number}).port;origin=`http://127.0.0.1:${port}`;
    env=writeTestDevspaceConfig(configDir,{server:{host:"127.0.0.1",port,publicBaseUrl:origin},
      workspaces:{allowedRoots:[project],worktreeRoot:join(root,"worktrees")},storage:{stateDir},ui:{enabled:interaction==="card"},skills:{enabled:false},logging:{level:"info",format:"json",requests:false,toolCalls:true,shellCommands:false},
      subagents:{enabled:false,providers:[]},goals:{enabled:false},chatGoals:{enabled:true,shrimpEntryPoint:shrimpEntry!,dataRoot}});
    const config=loadConfig(env);
    assert.throws(()=>createServer({...config,goals:{...config.chatGoals!,enabled:true}}),/requires native Goals and local subagents disabled/);
    service=createServer(config);http.on("request",service.app);
    const redirect="http://127.0.0.1/callback",resource=`${origin}/mcp`;
    const reg=await fetch(`${origin}/register`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({client_name:"Isolated deterministic Chat Goal protocol test",redirect_uris:[redirect],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]})});
    assert.equal(reg.status,201);const registration=await reg.json() as {client_id:string};
    const verifier=randomUUID()+randomUUID(),challenge=createHash("sha256").update(verifier).digest("base64url");
    const auth=await fetch(`${origin}/authorize`,{method:"POST",redirect:"manual",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:registration.client_id,response_type:"code",redirect_uri:redirect,scope:"devspace",resource,code_challenge:challenge,code_challenge_method:"S256",owner_token:service.config.oauth.ownerToken})});
    assert.equal(auth.status,302,await auth.text());
    const code=new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const exchange=await fetch(`${origin}/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:registration.client_id,grant_type:"authorization_code",code,redirect_uri:redirect,code_verifier:verifier,resource})});
    assert.equal(exchange.status,200);const token=await exchange.json() as {access_token:string};
    client=new Client({name:"Deterministic SDK client, NOT hosted ChatGPT",version:"1"},{capabilities:interaction==="form"?{elicitation:{form:{}}}:{}});
    await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));
    assert.match(client.getInstructions()!.slice(0,512),/chat_goal_preflight before opening a workspace/);
    const listed=(await client.listTools()).tools,names=listed.map(t=>t.name);
    for(const tool of listed.filter(t=>t.name.startsWith("chat_goal_"))){
      assert.equal(tool.outputSchema?.type,"object",tool.name);
      assert.equal(tool.annotations?.readOnlyHint,["chat_goal_preflight","chat_goal_status","chat_goal_status_by_path"].includes(tool.name));
    }
    // Validate real structured failures too; SDK clients skip validation on isError.
    const callOriginal=client.callTool.bind(client);
    client.callTool=async(...args)=>{
      const reply=await callOriginal(...args),tool=listed.find(t=>t.name===args[0].name);
      if(tool?.name.startsWith("chat_goal_")&&reply.structuredContent){
        assert.equal(chatGoalOutputSchemas[tool.name as ChatGoalToolName].safeParse(reply.structuredContent).success,true,JSON.stringify(reply));
        const checked=new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(reply.structuredContent);
        assert.equal(checked.valid,true,JSON.stringify(checked));
      }
      return reply;
    };
    assert.ok(names.includes("chat_goal_create"));assert.ok(names.includes("chat_goal_preflight"));assert.ok(names.includes("chat_goal_status_by_path"));
    assert.ok(names.includes("chat_goal_handoff"));assert.ok(names.includes("chat_goal_resume"));
    assert.ok(!names.includes("goal_start"));assert.ok(!names.some(n=>/^.*subagent|^start_agent/.test(n)));
    const preflight=await client.callTool({name:"chat_goal_preflight",arguments:{}});
    if(interaction==="form")assert.equal((preflight.structuredContent as Record<string,any>).data.status,"capability_declared");
    else {
      assert.equal((preflight.structuredContent as Record<string,any>).data.canCreateOrClaim,false);
      const connected=await client.callTool({name:"chat_goal_card_connect",arguments:{requestKey:randomUUID()}});
      assert.notEqual(connected.isError,true,JSON.stringify(connected));
      const meta=connected._meta!.goalCard as any;cardChannelId=meta.cardId;
      appClient=new Client({name:"Deterministic app-only caller, separate MCP transport",version:"1"});
      await appClient.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));
      const resourceResult=await appClient.readResource({uri:"ui://devspace/chat-goal-decision-v1.html"});
      assert.match(JSON.stringify(resourceResult),/目标决策卡片/);
      assert.equal((await appClient.callTool({name:"chat_goal_card_status",arguments:{cardId:cardChannelId,submitToken:"0".repeat(64)}})).isError,true);
      await appClient.callTool({name:"chat_goal_card_status",arguments:{cardId:cardChannelId,submitToken:meta.submitToken}});
      const ready=await client.callTool({name:"chat_goal_card_ready",arguments:{cardId:cardChannelId}});
      assert.equal((ready.structuredContent as any).data.waitOutcome,"channel_ready");
      note("cross_transport_card_acknowledgement",{cardChannelId,goalCreated:false,hostedChatVerified:false});
    }
    const beforeOpen=await client.callTool({name:"chat_goal_status_by_path",arguments:{path:project}});
    assert.equal(beforeOpen.isError,false,JSON.stringify(beforeOpen));
    const beforeOpenGoals=(beforeOpen.structuredContent as Record<string,any>).data.goals as Array<Record<string,any>>;
    if(!goalRef) assert.deepEqual(beforeOpenGoals,[]);
    else assert.ok(beforeOpenGoals.some(goal=>goal.goalRef===goalRef));
    const opened=await client.callTool({name:"open_workspace",arguments:{path:project,access:"modify"}});
    workspaceId=(opened.structuredContent as Record<string,any>).workspaceId;assert.ok(workspaceId);
    const invalid=await client.callTool({name:"chat_goal_status",arguments:{workspaceId:123}});
    assert.equal(invalid.isError,true);assert.match(JSON.stringify(invalid),/Input validation error/);
    note("http_entry_connected",{origin,workspaceId,chatTools:names.filter(n=>n.startsWith("chat_goal_")),nativeGoalStartVisible:false});
    // Additional real HTTP sessions must not inherit the first client's form
    // capability. They create no Goal, no task claim and no question request.
    for(const mode of ["missing","url_only"] as const) {
      const blockedClient=new Client({name:`Isolated ${mode} form capability test`,version:"1"},{capabilities:mode==="missing"?{}:{elicitation:{url:{}}}});
      try {
        await blockedClient.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));
        const checked=await blockedClient.callTool({name:"chat_goal_preflight",arguments:{}});
        const checkedData=(checked.structuredContent as Record<string,any>).data;
        assert.equal(checkedData.status,"blocked");assert.equal(checkedData.canCreateOrClaim,false);
        const blockedOpen=await blockedClient.callTool({name:"open_workspace",arguments:{path:project,access:"modify"}});
        const blockedWorkspace=(blockedOpen.structuredContent as Record<string,any>).workspaceId;assert.ok(blockedWorkspace);
        const readStatus=async()=> (await blockedClient.callTool({name:"chat_goal_status",arguments:{workspaceId:blockedWorkspace,...(goalRef?{goalRef}:{})}})).structuredContent;
        const before=await readStatus(),projectBefore=(await readdir(project,{recursive:true})).sort(),dataBefore=(await readdir(dataRoot,{recursive:true})).sort();
        if(!goalRef) {assert.deepEqual(projectBefore,[]);assert.deepEqual(dataBefore,[]);assert.deepEqual((before as Record<string,any>).data.goals,[]);}
        const refused=await blockedClient.callTool({name:"chat_goal_create",arguments:{workspaceId:blockedWorkspace,requestKey:goalRef?"http-blocked-reconnect":"http-create",spec:contract}});
        assert.equal(refused.isError,true);assert.equal((refused.structuredContent as Record<string,any>).error.code,"HOST_FORM_UNSUPPORTED");
        if(goalRef) {
          const blockedNext=await blockedClient.callTool({name:"chat_goal_next",arguments:{workspaceId:blockedWorkspace,goalRef,expectedRevision:(before as Record<string,any>).data.revision,requestKey:"http-blocked-claim"}});
          assert.equal((blockedNext.structuredContent as Record<string,any>).error.code,"HOST_FORM_UNSUPPORTED");
        }
        assert.deepEqual(await readStatus(),before);assert.deepEqual((await readdir(project,{recursive:true})).sort(),projectBefore);assert.deepEqual((await readdir(dataRoot,{recursive:true})).sort(),dataBefore);
        note("preflight_blocks_incompatible_http_session",{mode,afterACompleted:Boolean(goalRef),goalAndProjectUnchanged:true,status:checkedData.status,formDelivery:checkedData.formDelivery});
      } finally {await blockedClient.close();}
    }
    const stillDeclared=await client.callTool({name:"chat_goal_preflight",arguments:{...(cardChannelId?{cardChannelId}:{})}});
    assert.equal((stillDeclared.structuredContent as Record<string,any>).data.canCreateOrClaim,true);
  }
  async function close() {
    await appClient?.close();appClient=undefined;cardChannelId=undefined;
    await client?.close();client=undefined;
    await service?.close();service=undefined;
    if (http) {const owned=http;await new Promise<void>((r,j)=>{owned.close(e=>e?j(e):r());owned.closeAllConnections();});http=undefined;}
  }
  async function call(name:string,args:Record<string,unknown>,timeout=30000):Promise<any> {
    const result=await client!.callTool({name,arguments:{workspaceId,...(cardChannelId?{cardChannelId}:{}),...args}},undefined,{timeout});
    assert.ok(!result.isError,JSON.stringify(result));
    const body=result.structuredContent as Record<string,any>;
    if (name.startsWith("chat_goal_")) {assert.equal(body.ok,true,JSON.stringify(body));return body.data;}
    return body;
  }
  async function patch(path:string,content:string) {
    await call("apply_patch",{patch:`*** Begin Patch\n*** Add File: ${path}\n${content.trimEnd().split("\n").map(line=>`+${line}`).join("\n")}\n*** End Patch`});
  }
  const baselinePath=process.env.DEVSPACE_CHAT_LEGACY_TASK_FILE;
  const baseline=baselinePath?createHash("sha256").update(await readFile(baselinePath)).digest("hex"):undefined;
  try {
    await start();
    let state=await call("chat_goal_create",{requestKey:"http-create",spec:contract});goalRef=state.goalRef;
    const replayed=await client!.callTool({name:"chat_goal_create",arguments:{workspaceId,requestKey:"http-create",spec:contract,...(cardChannelId?{cardChannelId}:{})}});
    assert.equal((replayed.structuredContent as any).replayed,true);assert.equal((replayed.structuredContent as any).data.revision,state.revision);
    const first=await call("chat_goal_next",{goalRef,requestKey:"http-claim-a",expectedRevision:state.revision});
    await patch("TECH.md","# Technical notes\nadd(2, 3) = 5\n");
    state=await call("chat_goal_complete",{goalRef,requestKey:"http-complete-a",expectedRevision:first.revision,taskId:first.lease.taskId,leaseToken:first.lease.token,assessment:"Read the actual technical notes and confirmed that the agreed addition example is documented."});
    assert.equal(state.nextTask.name,"Task B");note("a_completed",{goalRef,revision:state.revision,taskCommit:state.taskCommit});
    state=await call("chat_goal_handoff",{goalRef,requestKey:"http-handoff-after-a",expectedRevision:state.revision});
    const handoffId=state.handoff.id;
    assert.equal(state.nextAction,"resume_handoff");assert.equal(state.handoff.state,"pending");assert.equal(state.additionalModelCalls,0);
    await close();await start();
    state=await call("chat_goal_status",{goalRef});assert.equal(state.nextTask.name,"Task B");assert.equal(state.tasks.find((t:any)=>t.name==="Task A").status,"completed");
    assert.equal(state.nextAction,"resume_handoff");assert.equal(state.handoff.id,handoffId);assert.equal(state.handoff.state,"pending");
    const pathStatus=await client!.callTool({name:"chat_goal_status_by_path",arguments:{path:project,goalRef}});
    const pathState=(pathStatus.structuredContent as Record<string,any>).data;
    assert.equal(pathStatus.isError,false,JSON.stringify(pathStatus));assert.equal(pathState.revision,state.revision);assert.equal(pathState.nextTask.name,"Task B");assert.equal(pathState.nextAction,"resume_handoff");
    state=await call("chat_goal_resume",{goalRef,requestKey:"http-resume-after-a",expectedRevision:state.revision,handoffId});
    assert.equal(state.nextAction,"claim_next_task");assert.equal(state.handoff.state,"consumed");assert.equal(state.nextTask.name,"Task B");
    note("server_restarted_and_handoff_resumed",{goalRef,nextTask:state.nextTask.name,handoffId,additionalModelCalls:state.additionalModelCalls});
    if(interaction==="form"){
      let requested=0;
      client!.setRequestHandler(ElicitRequestSchema,async request=>{
      requested++;assert.equal(request.params.mode,"form");
      await new Promise(r=>setTimeout(r,31_000));
      return {action:"accept",content:{answer:"Continue the agreed addition example"}};
    });
    const waitStarted=Date.now();
    state=await call("chat_goal_ask",{goalRef,requestKey:"http-choice",expectedRevision:state.revision,question:"Which example should the remaining documents use?",choices:["Continue the agreed addition example","Pause and revise the objective"]},65_000);
    assert.equal(requested,1);assert.equal(state.decision.state,"accepted");assert.equal(state.state,"ready");
      note("elicitation_resolved_original_tools_call",{waitMs:Date.now()-waitStarted,answer:state.decision.answer,hostedChatVerified:false});
    }else{
      const shown=await client!.callTool({name:"chat_goal_ask_card",arguments:{workspaceId,goalRef,cardChannelId,requestKey:"http-card-choice",expectedRevision:state.revision,question:"Which example should the remaining documents use?",choices:["Continue the agreed addition example","Pause and revise the objective"]}});
      assert.notEqual(shown.isError,true,JSON.stringify(shown));const meta=shown._meta!.goalCard as any;
      const waiting=call("chat_goal_wait_decision",{cardId:meta.cardId},55_000);
      let active=false;
      for(let i=0;i<50;i++){
        const snapshot=await appClient!.callTool({name:"chat_goal_card_status",arguments:{cardId:meta.cardId,submitToken:meta.submitToken}});
        if((snapshot.structuredContent as any).data.waitActive){active=true;break;}
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(active,true);
      // A pending decision prevents the host from claiming B or bypassing it.
      const pendingStatus=await call("chat_goal_status",{goalRef});
      const blockedNext=await client!.callTool({name:"chat_goal_next",arguments:{workspaceId,goalRef,cardChannelId,requestKey:"cannot-bypass-card",expectedRevision:pendingStatus.revision}});
      assert.equal(blockedNext.isError,true);
      const submitted=await appClient!.callTool({name:"chat_goal_card_submit",arguments:{cardId:meta.cardId,submitToken:meta.submitToken,action:"accept",answer:"Continue the agreed addition example"}});
      assert.notEqual(submitted.isError,true,JSON.stringify(submitted));
      const waited=await waiting;assert.equal(waited.waitOutcome,"answer_received");assert.equal(waited.activeWaitAtSubmission,true);
      state=waited.goal;assert.equal(state.state,"ready");assert.equal(state.decision.state,"accepted");
      const version=state.revision;
      await appClient!.callTool({name:"chat_goal_card_submit",arguments:{cardId:meta.cardId,submitToken:meta.submitToken,action:"accept",answer:"Continue the agreed addition example"}});
      assert.equal((await call("chat_goal_status",{goalRef})).revision,version);
      note("card_resolved_original_tools_call",{cardId:meta.cardId,waitOutcome:waited.waitOutcome,receiptPhase:waited.receiptPhase,hostedChatVerified:false});
    }
    const second=await call("chat_goal_next",{goalRef,requestKey:"http-claim-b",expectedRevision:state.revision});
    await patch("app.mjs","export function add(a, b) { return a + b; }\n");
    state=await call("chat_goal_complete",{goalRef,requestKey:"http-complete-b",expectedRevision:second.revision,taskId:second.lease.taskId,leaseToken:second.lease.token,assessment:"Read the implemented pure addition function. The following task performs the actual runtime assertion."});
    const third=await call("chat_goal_next",{goalRef,requestKey:"http-claim-c",expectedRevision:state.revision});
    const executed=await call("exec_command",{cmd:"node --input-type=module -e \"import {add} from './app.mjs'; if(add(2,3)!==5) throw new Error('assertion failed'); console.log('PASS: add(2, 3) = 5');\"",yieldTimeMs:10000,maxOutputTokens:1000});
    assert.equal(executed.exitCode,0,JSON.stringify(executed));assert.match(JSON.stringify(executed),/PASS/);
    note("real_devspace_command",{exitCode:executed.exitCode,sessionId:executed.sessionId??null});
    await patch("TEST.md","# Test result\nPASS: add(2, 3) = 5\n");
    state=await call("chat_goal_complete",{goalRef,requestKey:"http-complete-c",expectedRevision:third.revision,taskId:third.lease.taskId,leaseToken:third.lease.token,assessment:"The real DevSpace command exited zero and printed the expected result; all three agreed artifacts are verified."});
    assert.equal(state.state,"completed");assert.equal(state.nextAction,"stop");assert.ok(state.tasks.every((t:any)=>t.status==="completed"));
    const legacyUnchanged=baselinePath?createHash("sha256").update(await readFile(baselinePath)).digest("hex")===baseline:null;
    if (baselinePath) assert.equal(legacyUnchanged,true);
    const byAttempt=new Map<string,Record<string,unknown>[]>();
    for(const trace of traces){const id=String(trace.attemptId);byAttempt.set(id,[...(byAttempt.get(id)??[]),trace]);}
    const attempts=[...byAttempt.values()];
    await writeFile(join(root,"HTTP-TRACE.json"),JSON.stringify({interaction,traces},null,2));
    print(`Chat Goal trace evidence: ${join(root,"HTTP-TRACE.json")}`);
    assert.ok(attempts.some(a=>a.some(e=>e.outcome==="input_validation_failed")&&!a.some(e=>e.phase==="input_validated")));
    assert.ok(attempts.some(a=>a.some(e=>e.phase==="journal_replayed")&&a.some(e=>e.replayed===true&&e.phase==="response_ready")));
    assert.ok(attempts.some(a=>a.some(e=>e.tool==="chat_goal_next")&&["request_received","input_validated","authorization_passed","journal_committed","response_ready","transport_send_completed"].every(p=>a.some(e=>e.phase===p))));
    assert.ok(attempts.some(a=>a.some(e=>e.outcome==="tool_error")&&!a.some(e=>e.phase==="journal_started")));
    for(const forbidden of ["leaseToken","submitToken","http-create","Continue the agreed addition example","test-owner-token",project,goalRef])assert.ok(!JSON.stringify(traces).includes(forbidden),forbidden);
    const report={result:"PASS_LOCAL_HTTP",interaction,scope:"Real DevSpace OAuth + Streamable HTTP MCP + original Shrimp + actual workspace execution, driven by deterministic test code",hostedChatAcceptance:"NOT_RUN",chatQuota:"UNVERIFIED",extraModelCalls:0,legacyTaskDataUnchanged:legacyUnchanged,events,traces,finalState:state,project,dataRoot};
    await writeFile(join(root,"HTTP-ACCEPTANCE.json"),JSON.stringify(report,null,2));
    console.log(`Chat Goal HTTP evidence: ${join(root,"HTTP-ACCEPTANCE.json")}`);
  }finally{await close();}
});

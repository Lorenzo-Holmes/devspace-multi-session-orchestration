import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createServer as createNetServer} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createServer} from '../src/server.js';
import {loadConfig} from '../src/config.js';
import {writeTestDevspaceConfig} from '../src/test-support/config.test.js';
import {LocalAgentDaemon,type LocalAgentDaemonManager} from '../src/local-agent-daemon.js';
import {LocalAgentClient} from '../src/local-agent-client.js';
import {GoalManager} from '../src/goal-manager.js';
import {LocalAgentRuntimePool} from '../src/local-agent-runtime-pool.js';
import {readGoalTasks} from '../src/goal-evidence.js';

const runId=process.argv[2];
if(!/^run-[a-z0-9-]+$/.test(runId??''))throw new Error('Unique run- identifier required.');
const base='D:/DevSpace-Goal-PoC/.poc/replan-v1';
const evidence=join(base,'evidence',runId),project=join(base,'fixture',runId),secondProject=join(base,'fixture',runId+'-stop');
const dataRoot=join('D:/AgentState/_poc/shrimp/replan-v1',runId);
for(const path of [evidence,project,secondProject,dataRoot]) {if(existsSync(path))throw new Error('Refusing to overwrite existing probe.');await mkdir(path,{recursive:true});}
const codexCommand=process.env.POC_CODEX_EXE;
assert.ok(codexCommand&&existsSync(codexCommand));
const checks:Record<string,boolean>={},events:unknown[]=[];
const stateDir=join(evidence,'state');
const free=createNetServer();await new Promise<void>(r=>free.listen(0,'127.0.0.1',r));
const port=(free.address() as {port:number}).port;await new Promise<void>((r,j)=>free.close(e=>e?j(e):r()));
const origin=`http://127.0.0.1:${port}`,resource=`${origin}/mcp`;
const env=writeTestDevspaceConfig(join(evidence,'config'),{server:{host:'127.0.0.1',port,publicBaseUrl:origin},
  workspaces:{allowedRoots:[project,secondProject]},storage:{stateDir},ui:{enabled:false},skills:{enabled:false},
  logging:{level:'silent'},goals:{enabled:true,shrimpEntryPoint:'D:/DevSpace-Goal-PoC/dist/index.js',dataRoot,codexCommand}});
const config=loadConfig({...process.env,...env});
let pool:LocalAgentRuntimePool,goals:GoalManager,daemon:LocalAgentDaemon;
function ordinaryManager():LocalAgentDaemonManager {
  return {activeTurnCount:0,get runtimeCount(){return pool.size;},
    start:async()=>{throw new Error('ordinary subagents out of scope');},continue:async()=>{throw new Error('out of scope');},
    get:()=>{throw new Error('out of scope');},list:()=>{throw new Error('out of scope');},
    evictIdle:async()=>{},close:async()=>pool.close()};
}
async function startDaemon() {
  pool=new LocalAgentRuntimePool();
  goals=new GoalManager({stateDir,config:config.goals!,pool,authorize:async root=>{
    if(![project,secondProject].some(p=>p.toLowerCase().replaceAll('\\','/')===root.toLowerCase().replaceAll('\\','/')))throw new Error('WORKSPACE_ACCESS_REQUIRED');
  }});
  daemon=new LocalAgentDaemon({stateDir,manager:ordinaryManager(),goals,onLockAcquired:()=>goals.reconcile(),idleShutdownMs:60000});
  await daemon.start();
}
await startDaemon();
const api=new LocalAgentClient({stateDir,spawnDaemon:()=>{throw new Error('Probe owns daemon lifecycle');}});
const server=createServer(config,{goalApi:api});
const http=server.app.listen(port,'127.0.0.1');await new Promise<void>((r,j)=>{http.once('listening',r);http.once('error',j);});
const clients:Client[]=[];
async function connect():Promise<Client> {
  // The actual OAuth route with the isolated test owner's password; no production grant/token changes.
  const redirect='http://127.0.0.1/callback';
  const reg=await fetch(`${origin}/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Goal entry acceptance',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(reg.status,201);const registration=await reg.json() as {client_id:string};
  const verifier=randomUUID()+randomUUID(),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authParams={client_id:registration.client_id,response_type:'code',redirect_uri:redirect,scope:'devspace',resource,code_challenge:challenge,code_challenge_method:'S256',owner_token:config.oauth.ownerToken};
  const authorization=await fetch(`${origin}/authorize`,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(authParams)});
  assert.equal(authorization.status,302,await authorization.text());
  const code=new URL(authorization.headers.get('location')!).searchParams.get('code')!;
  const tokenResponse=await fetch(`${origin}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:registration.client_id,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource})});
  assert.equal(tokenResponse.status,200);const token=await tokenResponse.json() as {access_token:string};
  const client=new Client({name:'goal-web-entry-probe',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));clients.push(client);return client;
}
async function call(client:Client,name:string,args:Record<string,unknown>) {
  const r=await client.callTool({name,arguments:args});
  const data=(r.structuredContent??JSON.parse((r.content as Array<{text:string}>)[0].text)) as Record<string,any>;
  if(!data.ok)throw new Error(JSON.stringify(data));return data.data as Record<string,any>;
}
function note(kind:string,data:unknown) {events.push({at:new Date().toISOString(),kind,data});console.log(JSON.stringify({kind,data}));}
async function until(fn:()=>Promise<boolean>,limit=360000) {
  const deadline=Date.now()+limit;
  while(!(await fn())) {if(Date.now()>deadline)throw new Error('Acceptance deadline exceeded.');await new Promise(r=>setTimeout(r,300));}
}
let goalRef:string|undefined,failure:string|undefined;
try {
  let client=await connect();
  const names=(await client.listTools()).tools.map(t=>t.name);
  checks.sixToolsVisible=['goal_start','goal_status','goal_list','goal_pause','goal_resume','goal_stop'].every(n=>names.includes(n));assert.ok(checks.sixToolsVisible);
  const opened=await client.callTool({name:'open_workspace',arguments:{path:project,access:'modify'}});
  const workspaceId=(opened.structuredContent as Record<string,any>).workspaceId;assert.ok(workspaceId);
  const input={workspaceId,objective:'创建 A.md、B.md、C.md 三个真实文档，内容分别是 Alpha、Bravo、Charlie。必须规划且仅规划 Task A → Task B → Task C 三个依赖任务。每个任务只创建同名字母文件，每项完成后结束当前轮，供原生 Goal 自动继续。',successCriteria:'A.md 包含 Alpha，B.md 包含 Bravo，C.md 包含 Charlie；三项通过 record_task_evidence 与 verify_task 后整体完成。',constraints:'只写三个 Markdown 文件，不联网、不安装、不使用子代理。',requestKey:runId};
  const started=await call(client,'goal_start',input);goalRef=started.goalRef;assert.ok(goalRef);note('accepted',{goalRef});
  checks.creationDedup=(await call(client,'goal_start',input)).goalRef===goalRef;assert.ok(checks.creationDedup);
  let status:Record<string,any>=started;
  await until(async()=>{status=await call(client,'goal_status',{goalRef});if(status.error)throw new Error(JSON.stringify(status.error));return status.tasks?.some((t:any)=>t.status==='completed');});
  const firstComplete=status.tasks.filter((t:any)=>t.status==='completed');
  assert.ok(firstComplete.length<3,'Goal finished before pause window; preserve evidence and repeat with a larger real test.');
  const completedId=firstComplete[0].id;
  const paused=await call(client,'goal_pause',{goalRef,expectedRevision:status.revision,requestKey:runId+'-pause'});note('pause-request',paused.controlState);
  await until(async()=>{status=await call(client,'goal_status',{goalRef});return status.controlState==='paused'&&!status.runtimeConnected;},60000);
  checks.pauseAcknowledged=true;
  const nativeThread=status.threadId,proof=JSON.stringify(status.checkpoints.find((p:any)=>p.taskId===completedId));
  const binding=goals.store.get('single-user',goalRef!);const before=(await readGoalTasks(binding.dataDir)).tasks.find(t=>t.id===completedId);
  await client.close();await daemon.close();note('boundary','Closed MCP client and the owned daemon; same binding/state retained.');
  await startDaemon();client=await connect();
  const listed=await call(client,'goal_list',{});
  checks.crossClientAndDaemonRecovery=listed.goals.some((g:any)=>g.goalRef===goalRef&&g.threadId===nativeThread);assert.ok(checks.crossClientAndDaemonRecovery);
  status=await call(client,'goal_status',{goalRef});
  assert.equal(status.controlState,'paused');
  await call(client,'goal_resume',{goalRef,expectedRevision:status.revision,requestKey:runId+'-resume'});
  await client.close();note('boundary','Disconnected the web-like MCP consumer after resume; daemon keeps execution.');
  // Consumer remains absent while the real native model completes the dependency chain.
  await until(async()=>{const r=await api.goal({action:'status',ownerRef:'single-user',goalRef:goalRef!});if(!r.ok)throw new Error(JSON.stringify(r));status=r.data!;if(status.error)throw new Error(JSON.stringify(status.error));return status.controlState==='completed'&&!status.runtimeConnected;});
  client=await connect();status=await call(client,'goal_status',{goalRef});
  checks.sameNativeThread=status.threadId===nativeThread;
  const after=(await readGoalTasks(binding.dataDir)).tasks;
  checks.noRepeatCompleted=JSON.stringify(after.find(t=>t.id===completedId))===JSON.stringify(before)&&JSON.stringify(status.checkpoints.find((p:any)=>p.taskId===completedId))===proof;
  checks.threeCompleted=after.length===3&&after.every(t=>t.status==='completed');
  const a=after.find(t=>t.name==='Task A')!,b=after.find(t=>t.name==='Task B')!,c=after.find(t=>t.name==='Task C')!;
  checks.dependencies=b.dependencies.some(d=>d.taskId===a.id)&&c.dependencies.some(d=>d.taskId===b.id);
  checks.actualArtifacts=(await readFile(join(project,'A.md'),'utf8')).includes('Alpha')&&(await readFile(join(project,'B.md'),'utf8')).includes('Bravo')&&(await readFile(join(project,'C.md'),'utf8')).includes('Charlie');
  checks.notFalseAcceptance=status.verification==='artifact_checks_recorded_user_acceptance_required';
  const ws2=await client.callTool({name:'open_workspace',arguments:{path:secondProject,access:'modify'}});
  const stoppedStart=await call(client,'goal_start',{workspaceId:(ws2.structuredContent as any).workspaceId,objective:'创建一个文字文件 result.md。',successCriteria:'文件有实际内容。',constraints:'仅限项目。',requestKey:runId+'-stop-start'});
  await call(client,'goal_stop',{goalRef:stoppedStart.goalRef,expectedRevision:stoppedStart.revision,requestKey:runId+'-stop'});
  await until(async()=>{const s=await call(client,'goal_status',{goalRef:stoppedStart.goalRef});return s.controlState==='stopped'&&!s.runtimeConnected;},90000);
  checks.stopAcknowledged=true;
  assert.ok(Object.values(checks).every(Boolean));
} catch(error) {failure=(error as Error).message;note('FAIL',failure);process.exitCode=1;}
finally {
  await Promise.allSettled(clients.map(c=>c.close()));await daemon.close();await server.close();await new Promise<void>(r=>http.close(()=>r()));
  const result={result:failure?'FAIL':'PASS',checks,failure,goalRef,project,dataRoot,consumer:'Real OAuth + HTTP MCP + existing daemon client + native Goal + original Shrimp; not the hosted ChatGPT connector UI',events};
  await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}

import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';

// Deterministic public transport test. Never starts a Codex/API/local reasoning model.
const runId=process.argv[2];assert.match(runId??'',/^run-chat-public-[a-z0-9-]+$/);
const base='D:/DevSpace-Goal-PoC/.poc/replan-v1';
const evidence=join(base,'evidence',runId);
const project=join('D:/DevSpace-Goal-PoC/user-acceptance',`chat-deployment-${runId.slice('run-chat-public-'.length)}`);
let evidenceExists=true;try{await access(evidence);}catch{evidenceExists=false;}
assert.equal(evidenceExists,false,'Do not overwrite a previous evidence run');
await mkdir(evidence);await mkdir(project,{recursive:true});
assert.equal((await readdir(project)).length,0,'Requires exact empty deployment test directory');
const pointer=JSON.parse(await readFile('D:/DevSpace/devspace/.devspace-release.json','utf8'));
assert.equal(pointer.buildId,'chat-goal-preview-20260908-01');
const {loadConfig}=await import(pathToFileURL(join(dirname(pointer.entryPoint),'config.js')).href);
const config=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:'D:/DevSpace/devspace/.devspace-config'});
assert.equal(config.publicBaseUrl,'https://devspace.lorenzoholmes.me');
assert.ok(config.chatGoals?.enabled&&!config.goals?.enabled&&!config.subagents.enabled);
const origin=config.publicBaseUrl,resource=`${origin}/mcp`;
const events=[],checks={},clients=[],tokens=[];
const hash=value=>createHash('sha256').update(value).digest('hex');
const note=(event,data)=>{events.push({at:new Date().toISOString(),event,data});console.log(JSON.stringify({event,data}));};
async function request(path,options){return fetch(`${origin}${path}`,{redirect:'manual',...options,signal:AbortSignal.timeout(15000)});}
async function connect(){
  const redirect='http://127.0.0.1/callback';
  const reg=await request('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:`Chat Goal deterministic acceptance ${runId}`,redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(reg.status,201,'Public registration failed');
  const registration=await reg.json(),verifier=randomUUID()+randomUUID();
  const auth=await request('/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:registration.client_id,response_type:'code',redirect_uri:redirect,scope:'devspace',resource,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',owner_token:config.oauth.ownerToken})});
  assert.equal(auth.status,302,'Public owner authentication failed');
  const location=new URL(auth.headers.get('location'));assert.equal(location.origin+location.pathname,redirect);
  const code=location.searchParams.get('code');assert.ok(code);
  const exchange=await request('/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:registration.client_id,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource})});
  assert.equal(exchange.status,200,'Public token exchange failed');
  const token=await exchange.json();assert.ok(token.access_token);tokens.push({clientId:registration.client_id,...token});
  const client=new Client({name:'Deterministic SDK; NOT hosted ChatGPT',version:'1'},{capabilities:{elicitation:{form:{}}}});
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));
  clients.push(client);return client;
}
let client,workspaceId,goalRef,state,failure;
async function call(name,args,timeout=30000){
  const reply=await client.callTool({name,arguments:{...(workspaceId?{workspaceId}:{}),...args}},undefined,{timeout});
  assert.ok(!reply.isError,`${name}: ${JSON.stringify(reply)}`);
  const body=reply.structuredContent??JSON.parse(reply.content.find(c=>c.type==='text').text);
  if(name.startsWith('chat_goal_')){assert.equal(body.ok,true,JSON.stringify(body.error));return body.data;}
  return body;
}
async function patch(path,content){return call('apply_patch',{patch:`*** Begin Patch\n*** Add File: ${path}\n${content.trimEnd().split('\n').map(line=>'+'+line).join('\n')}\n*** End Patch`});}
async function parentState(){
  const parent='D:/DevSpace-Goal-PoC';
  const git=(...args)=>execFileSync('git',['-C',parent,...args],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
  return {head:git('rev-parse','HEAD'),refs:hash(git('show-ref')),index:hash(await readFile(join(parent,'.git/index'))),objects:git('count-objects','-v')};
}
const before=await parentState();
try{
  client=await connect();
  const tools=(await client.listTools()).tools;
  const names=tools.map(t=>t.name);
  const chatNames=['chat_goal_create','chat_goal_status','chat_goal_next','chat_goal_complete','chat_goal_control','chat_goal_ask'];
  checks.sixNewTools=chatNames.every(n=>names.includes(n));assert.ok(checks.sixNewTools);
  checks.noNativeGoalTools=!names.some(n=>n.startsWith('goal_'));assert.ok(checks.noNativeGoalTools);
  await writeFile(join(evidence,'public-tools.json'),JSON.stringify(tools,null,2),{flag:'wx'});
  note('public_tools',{chatNames,nativeGoalToolsVisible:false});
  const opened=await call('open_workspace',{path:project,access:'modify'});workspaceId=opened.workspaceId;assert.ok(workspaceId);
  note('workspace',{workspaceId,project});
  const input={requestKey:runId+'-create',spec:{objective:'Build and verify a tiny addition module',successCriteria:'Technical notes, working addition module, and a passing test report',constraints:'Only this isolated directory; no model calls, network tasks or installs',tasks:[
    {name:'Task A',description:'Write technical notes documenting addition behavior.',implementationGuide:'Create TECH.md describing add(2, 3) returning 5.',dependencies:[],checks:[{path:'TECH.md',contains:'add(2, 3) = 5'}]},
    {name:'Task B',description:'Implement the pure addition function in an ES module.',implementationGuide:'Create app.mjs exporting add(a, b).',dependencies:['Task A'],checks:[{path:'app.mjs',contains:'export function add'}]},
    {name:'Task C',description:'Execute the actual module assertion and record its result.',implementationGuide:'Run a Node assertion through DevSpace and write TEST.md only after exit zero.',dependencies:['Task B'],checks:[{path:'TEST.md',contains:'PASS: add(2, 3) = 5'}]},
  ]}};
  state=await call('chat_goal_create',input);goalRef=state.goalRef;assert.ok(goalRef);
  checks.createIdempotency=(await call('chat_goal_create',input)).goalRef===goalRef;assert.ok(checks.createIdempotency);
  let claimed=await call('chat_goal_next',{goalRef,requestKey:runId+'-claim-a',expectedRevision:state.revision});
  await patch('TECH.md','# Technical notes\nadd(2, 3) = 5\n');
  state=await call('chat_goal_complete',{goalRef,requestKey:runId+'-complete-a',expectedRevision:claimed.revision,taskId:claimed.lease.taskId,leaseToken:claimed.lease.token,assessment:'The actual technical notes contain the agreed example; file checks and the checkpoint are required before completing this task.'});
  const firstTaskId=state.tasks.find(t=>t.name==='Task A').id;
  assert.equal(state.nextTask.name,'Task B');
  note('task_a_completed',{goalRef,revision:state.revision,nextTask:state.nextTask.name});
  await client.close();client=await connect();
  const reopened=await call('open_workspace',{path:project,access:'modify'});
  // Workspace handles are connection-local. The durable identity is the exact root + Goal ID.
  assert.ok(reopened.workspaceId);workspaceId=reopened.workspaceId;
  state=await call('chat_goal_status',{goalRef});
  checks.reconnectSelectsB=state.nextTask.name==='Task B'&&state.tasks.find(t=>t.name==='Task A').status==='completed';
  assert.ok(checks.reconnectSelectsB);note('independent_client_recovered',{goalRef,nextTask:state.nextTask.name});
  let questions=0;
  client.setRequestHandler(ElicitRequestSchema,async request=>{questions++;assert.equal(request.params.mode,'form');return {action:'accept',content:{answer:'Continue the agreed addition example'}};});
  state=await call('chat_goal_ask',{goalRef,requestKey:runId+'-choice',expectedRevision:state.revision,question:'Which example should the remaining artifacts use?',choices:['Continue the agreed addition example','Pause and revise']},65000);
  checks.publicElicitationRoundTrip=questions===1&&state.decision.state==='accepted'&&state.state==='ready';assert.ok(checks.publicElicitationRoundTrip);
  note('deterministic_form_round_trip',{accepted:true,hostedChatTest:false});
  claimed=await call('chat_goal_next',{goalRef,requestKey:runId+'-claim-b',expectedRevision:state.revision});
  assert.notEqual(claimed.lease.taskId,firstTaskId);
  await patch('app.mjs','export function add(a, b) { return a + b; }\n');
  state=await call('chat_goal_complete',{goalRef,requestKey:runId+'-complete-b',expectedRevision:claimed.revision,taskId:claimed.lease.taskId,leaseToken:claimed.lease.token,assessment:'The actual ES module exports the agreed pure addition function. Task C must execute the runtime check before overall completion.'});
  claimed=await call('chat_goal_next',{goalRef,requestKey:runId+'-claim-c',expectedRevision:state.revision});
  const executed=await call('exec_command',{cmd:'node --input-type=module -e "import {add} from \'./app.mjs\'; if(add(2,3)!==5) throw new Error(\'assertion failed\'); console.log(\'PASS: add(2, 3) = 5\');"',yieldTimeMs:10000,maxOutputTokens:1000});
  assert.equal(executed.exitCode,0);assert.match(JSON.stringify(executed),/PASS: add\(2, 3\) = 5/);
  note('real_devspace_command',{exitCode:executed.exitCode});
  await patch('TEST.md','# Runtime test\nPASS: add(2, 3) = 5\n');
  state=await call('chat_goal_complete',{goalRef,requestKey:runId+'-complete-c',expectedRevision:claimed.revision,taskId:claimed.lease.taskId,leaseToken:claimed.lease.token,assessment:'The real DevSpace command exited zero and printed the expected value. All three artifacts satisfy the agreed frozen checks.'});
  checks.completedAndStopped=state.state==='completed'&&state.nextAction==='stop'&&state.tasks.every(t=>t.status==='completed');assert.ok(checks.completedAndStopped);
  state=await call('chat_goal_status',{goalRef});
  checks.noTaskARepeat=state.tasks.find(t=>t.name==='Task A').id===firstTaskId&&state.tasks.length===3;
  checks.parentGitUnchanged=JSON.stringify(await parentState())===JSON.stringify(before);assert.ok(checks.parentGitUnchanged);
  note('completed',{goalRef,state:state.state,nextAction:state.nextAction,revision:state.revision});
}catch(error){
  failure=error instanceof Error?error.message:String(error);process.exitCode=1;note('failure',failure);
  if(client&&goalRef)try{state=await call('chat_goal_status',{goalRef});if(!['completed','stopped'].includes(state.state)){state=await call('chat_goal_control',{goalRef,requestKey:runId+'-failure-stop',expectedRevision:state.revision,action:'stop'});}}catch{note('cleanup','Probe requires follow-up; no other Goal changed');}
}finally{
  await Promise.allSettled(clients.map(c=>c.close()));
  const revocations=[];
  for(const token of tokens)for(const type of ['access_token','refresh_token'])if(token[type]){
    try{const result=await request('/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:token.clientId,token:token[type],token_type_hint:type})});revocations.push(result.ok);}catch{revocations.push(false);}
  }
  const result={result:failure?'FAIL':'PASS_PUBLIC_PROTOCOL',at:new Date().toISOString(),release:pointer.buildId,publicOrigin:origin,consumer:'Official SDK deterministic test client, not hosted ChatGPT',extraReasoningModelCalls:0,hostedChatAcceptance:'NOT_RUN',chatQuota:'UNKNOWN_HOST_CONTROLLED',checks,failure,goalRef,workspaceId,project,finalState:state,probeTokensRevoked:revocations.length>0&&revocations.every(Boolean),events};
  await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({result:result.result,goalRef,checks,probeTokensRevoked:result.probeTokensRevoked}));
}

import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Deployment acceptance only: official SDK, real public OAuth, no protocol bridge or copied credentials.
const runId=process.argv[2];
assert.match(runId??'',/^run-public-[a-z0-9-]+$/);
const evidence=join('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence',runId);
assert.ok(!existsSync(evidence),'Never overwrite acceptance evidence.');
await mkdir(evidence,{recursive:true});
const project='D:/DevSpace-Goal-PoC/user-acceptance/deployment-smoke-20260908';
assert.equal((await readdir(project)).length,0,'Deployment smoke requires the exact empty test project.');
const pointer=JSON.parse(await readFile('D:/DevSpace/devspace/.devspace-release.json','utf8'));
const {loadConfig}=await import(pathToFileURL(join(pointer.entryPoint,'..','config.js')).href);
const config=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:'D:/DevSpace/devspace/.devspace-config'});
assert.equal(config.publicBaseUrl,'https://devspace.lorenzoholmes.me');
assert.ok(config.goals?.enabled);
const origin=config.publicBaseUrl,resource=`${origin}/mcp`;
const checks={},events=[],clients=[],tokens=[];
function note(kind,data){events.push({at:new Date().toISOString(),kind,data});console.log(JSON.stringify({kind,data}));}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const parent='D:/DevSpace-Goal-PoC';
async function parentState(){
  const git=(...args)=>execFileSync('git',['-C',parent,...args],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
  return {head:git('rev-parse','HEAD'),refs:hash(git('show-ref')),index:hash(await readFile(join(parent,'.git/index'))),objects:git('count-objects','-v')};
}
async function request(path,options){return fetch(`${origin}${path}`,{...options,signal:AbortSignal.timeout(15000)});}
async function connect(){
  const redirect='http://127.0.0.1/callback';
  const reg=await request('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:`DevSpace deployment acceptance ${runId}`,redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(reg.status,201,'Public OAuth registration failed.');
  const registration=await reg.json(),verifier=randomUUID()+randomUUID();
  const authorization=await request('/authorize',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:registration.client_id,response_type:'code',redirect_uri:redirect,scope:'devspace',resource,code_challenge:hashChallenge(verifier),code_challenge_method:'S256',owner_token:config.oauth.ownerToken})});
  assert.equal(authorization.status,302,'Public OAuth owner authentication failed.');
  const location=new URL(authorization.headers.get('location'));
  assert.equal(location.origin+location.pathname,redirect);
  const code=location.searchParams.get('code');assert.ok(code);
  const exchange=await request('/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:registration.client_id,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource})});
  assert.equal(exchange.status,200,'Public OAuth code exchange failed.');
  const token=await exchange.json();assert.ok(token.access_token);
  tokens.push({clientId:registration.client_id,...token});
  const client=new Client({name:'goal-public-entry-acceptance',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));
  clients.push(client);return client;
}
function hashChallenge(value){return createHash('sha256').update(value).digest('base64url');}
async function call(client,name,args){
  const r=await client.callTool({name,arguments:args});
  const result=r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
  assert.equal(result.ok,true,JSON.stringify(result.error));return result.data;
}
let client,goalRef,status,failure;
const before=await parentState();
try{
  client=await connect();
  const names=(await client.listTools()).tools.map(t=>t.name);
  checks.sixPublicTools=['goal_start','goal_status','goal_list','goal_pause','goal_resume','goal_stop'].every(n=>names.includes(n));
  assert.ok(checks.sixPublicTools);note('tools',names.filter(n=>n.startsWith('goal_')));
  const listed=await call(client,'goal_list',{});checks.publicList=Array.isArray(listed.goals);assert.ok(checks.publicList);
  const opened=await client.callTool({name:'open_workspace',arguments:{path:project,access:'modify'}});
  const workspace=opened.structuredContent;assert.ok(workspace?.workspaceId);
  checks.noParentSnapshot=workspace.review?.available===false&&/parent repositories are outside/.test(workspace.review.reason);
  assert.ok(checks.noParentSnapshot,JSON.stringify(workspace.review));
  assert.deepEqual(await parentState(),before);
  note('workspace',{workspaceId:workspace.workspaceId,review:workspace.review});
  const input={workspaceId:workspace.workspaceId,objective:'只规划一个任务并创建 READY.md，内容必须包含“网页入口已连接”与“持久化 Goal 验收”。这是已经批准的本地文件测试，完成后结束 Goal。',successCriteria:'只有一个任务；READY.md 存在并含两句指定中文；通过 record_task_evidence 与 verify_task 记录真实文件和 Git 检查点。',constraints:'只写 READY.md；不联网、不安装、不使用子代理、不请求额外权限。',requestKey:runId};
  status=await call(client,'goal_start',input);goalRef=status.goalRef;assert.ok(goalRef);note('accepted',{goalRef,controlState:status.controlState});
  checks.creationDedup=(await call(client,'goal_start',input)).goalRef===goalRef;assert.ok(checks.creationDedup);
  await client.close();note('disconnected','Closed the public MCP consumer; background Goal owns continuation.');
  // Reconnect with an independently registered, normally authenticated OAuth client.
  client=await connect();
  const recovered=await call(client,'goal_list',{});
  checks.crossClientRecovery=recovered.goals.some(g=>g.goalRef===goalRef);assert.ok(checks.crossClientRecovery);
  const deadline=Date.now()+300000;
  let prior='';
  while(true){
    status=await call(client,'goal_status',{goalRef});
    const compact=JSON.stringify({state:status.controlState,runtime:status.runtimeConnected,tasks:status.tasks?.map(t=>({name:t.name,status:t.status}))});
    if(compact!==prior){note('status',JSON.parse(compact));prior=compact;}
    if(status.error)throw new Error(JSON.stringify(status.error));
    if(status.controlState==='completed'&&!status.runtimeConnected)break;
    if(['paused','stopped'].includes(status.controlState))throw new Error(`Unexpected ${status.controlState}`);
    if(Date.now()>deadline)throw new Error('Public Goal completion deadline exceeded.');
    await new Promise(r=>setTimeout(r,3000));
  }
  const content=await readFile(join(project,'READY.md'),'utf8');
  checks.realArtifact=content.includes('网页入口已连接')&&content.includes('持久化 Goal 验收');
  checks.completedOneTask=status.tasks.length===1&&status.tasks[0].status==='completed';
  checks.gitEvidence=status.checkpoints.length===1&&!!status.checkpoints[0].projectCommit&&!!status.checkpoints[0].taskCommit;
  checks.notFalseUserAcceptance=status.verification==='artifact_checks_recorded_user_acceptance_required';
  checks.parentUnchangedAfterFix=JSON.stringify(await parentState())===JSON.stringify(before);
  assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
}catch(error){failure=error instanceof Error?error.message:String(error);process.exitCode=1;note('FAIL',failure);
  if(goalRef&&client)try{status=await call(client,'goal_status',{goalRef});if(!['completed','stopped'].includes(status.controlState)){await call(client,'goal_stop',{goalRef,expectedRevision:status.revision,requestKey:runId+'-failure-stop'});note('cleanup','Requested stop of this probe Goal only.');}}catch{note('cleanup','Probe Goal state requires follow-up; no other Goal was changed.');}
}finally{
  await Promise.allSettled(clients.map(c=>c.close()));
  const revocations=[];
  for(const token of tokens)for(const key of ['access_token','refresh_token'])if(token[key]){
    try{const revoked=await request('/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:token.clientId,token:token[key],token_type_hint:key})});revocations.push(revoked.ok);}catch{revocations.push(false);}
  }
  const result={result:failure?'FAIL':'PASS',at:new Date().toISOString(),release:pointer.buildId,sourceCommit:pointer.sourceCommit,publicOrigin:origin,consumer:'Official MCP SDK over the existing public fixed-domain OAuth/HTTP endpoint, not hosted ChatGPT UI',checks,failure,goalRef,project,status,probeTokensRevoked:revocations.every(Boolean),events};
  await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({result:result.result,goalRef,checks,probeTokensRevoked:result.probeTokensRevoked}));
}

import { mkdirSync,existsSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAppServerRuntime } from '../src/local-agent-codex.js';
const runId=process.argv[2];
if(!/^run-[a-z0-9-]+$/.test(runId??'')) throw new Error('Unique run id required');
const base='D:/DevSpace-Goal-PoC/.poc/replan-v1';
const cwd=join(base,'fixture',runId),evidence=join(base,'evidence',runId);
if(existsSync(cwd)||existsSync(evidence))throw new Error('Refusing overwrite');
mkdirSync(cwd,{recursive:true});mkdirSync(evidence,{recursive:true});
const r=new CodexAppServerRuntime({command:process.env.POC_CODEX_EXE!,env:process.env,enableGoalApi:true});
const approvals:Array<{method:string;threadId:unknown;decision:string}>=[];
let id:string|undefined,failure:string|undefined;
try{
 await r.initialize();
 id=await r.openGoalSession({workspaceRoot:cwd,writeMode:'read_only',developerInstructions:'Bounded approval-path test. Attempt only an apply_patch creating approval-probe.txt in cwd. Do not use shell, apps, network, or subagents. If approval is rejected or interrupted, stop immediately. No fallback execution.',onRequest:async(method,p)=>{
  if(['item/fileChange/requestApproval','item/commandExecution/requestApproval'].includes(method)){
   approvals.push({method,threadId:p.threadId,decision:'cancel'});
   return {decision:'cancel'};
  }
  throw new Error('No authorization');
 }});
 await r.setNativeGoal(id,{objective:'Test approval handling only: attempt to create approval-probe.txt with text probe using apply_patch. Respect sandbox and request approval if needed. On rejection do not retry; stop. No other work.',status:'active'});
 const deadline=Date.now()+90000;
 while(!approvals.length&&Date.now()<deadline&&r.isAlive())await new Promise(resolve=>setTimeout(resolve,250));
 await r.pauseNativeGoal(id);
 if(!approvals.length)throw new Error('No native approval request observed');
 if(existsSync(join(cwd,'approval-probe.txt')))throw new Error('Rejected write unexpectedly happened');
}catch(e){failure=(e as Error).message;process.exitCode=1;}
finally{
 if(id&&r.isAlive())await r.pauseNativeGoal(id).catch(()=>{});
 await r.close();
 const result={runId,threadId:id,approvals,failure,result:failure?'FAIL':'PASS',note:'Real native request, explicit denial; not proof of Web approval forwarding.'};
 writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}

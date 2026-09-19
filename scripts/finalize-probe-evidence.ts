import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { CodexAppServerRuntime } from '../src/local-agent-codex.js';
const evidence='D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/run-20260908-1252-e2e';
const report=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8'));
const binding=JSON.parse(readFileSync(join(evidence,'binding.json'),'utf8'));
assert.equal(report.result,'PASS');assert.equal(report.threadId,binding.threadId);
const snapshot=JSON.parse(readFileSync(join(evidence,'final-task-snapshot.json'),'utf8'));
assert.equal(createHash('sha256').update(readFileSync(join(binding.dataDir,'tasks.json'))).digest('hex'),snapshot.hash);
assert.ok(snapshot.tasks.length===3&&snapshot.tasks.every((t:any)=>t.status==='completed'));
const r=new CodexAppServerRuntime({command:process.env.POC_CODEX_EXE!,env:process.env,enableGoalApi:true});
try{
 await r.initialize();
 await r.openGoalSession({threadId:binding.threadId,workspaceRoot:binding.workspace,writeMode:'read_only',developerInstructions:'Completed test audit only; do not execute work.',onRequest:async()=>{throw new Error('No tools authorized during audit');}});
 const before=await r.getNativeGoal(binding.threadId);
 assert.ok(before?.objective.startsWith('Complete preseeded Task A then B then C'));
 assert.equal(r.activeGoalTurn(binding.threadId),undefined);
 const after=await r.setNativeGoal(binding.threadId,{status:'complete'});
 const result={before:before?.status,after:after.status,threadId:binding.threadId,reason:'All real artifacts independently verified; preserve terminal completion instead of test cleanup pause.'};
 writeFileSync(join(evidence,'native-final-status.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await r.close();}

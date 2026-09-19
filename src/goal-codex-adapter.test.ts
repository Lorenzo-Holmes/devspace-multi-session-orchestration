import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerRuntime } from './local-agent-codex.js';
const fixture = String.raw`
const readline = require('node:readline');
let goal=null; const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), p=m.params||{};
 if(m.method==='initialize') return out({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume') return out({id:m.id,result:{thread:{id:'thread-one'}}});
 if(m.method==='thread/goal/get') return out({id:m.id,result:{goal}});
 if(m.method==='thread/goal/set') {
  goal={threadId:p.threadId,objective:p.objective||goal?.objective,status:p.status||'active',tokenBudget:null,tokensUsed:7,timeUsedSeconds:2};
  out({id:m.id,result:{goal}});
  out({method:'thread/goal/updated',params:{threadId:p.threadId,goal}});
  if(p.status==='active') {
   out({method:'turn/started',params:{threadId:p.threadId,turn:{id:'turn-one',status:'inProgress'}}});
   out({id:901,method:'item/tool/call',params:{threadId:p.threadId,turnId:'turn-one',tool:'test',arguments:{}}});
   out({id:902,method:'item/tool/call',params:{threadId:'wrong-thread',turnId:'turn-other',tool:'test',arguments:{}}});
   out({id:903,method:'item/fileChange/requestApproval',params:{threadId:p.threadId,turnId:'turn-one'}});
  }
  return;
 }
 if(m.id===902) return out({method:'thread/goal/updated',params:{threadId:'thread-one',testUnknownRejected:m.error?.code===-32601}});
 if(m.id===903) return out({method:'thread/goal/updated',params:{threadId:'thread-one',testApprovalDenied:m.result?.decision==='decline'}});
 if(m.method==='turn/interrupt') {out({id:m.id,result:{}}); setTimeout(()=>out({method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}}}),40);return;}
 if(m.method==='thread/unsubscribe') return out({id:m.id,result:{}});
 if(m.method==='turn/start') throw new Error('Native Goal adapter must not initiate a second scheduler');
});`;
const makeRuntime = (enabled=true) => new CodexAppServerRuntime({command:process.execPath,appServerArgs:['-e',fixture],env:process.env,enableGoalApi:enabled});
test('native methods route only owned requests and pause waits for interrupt acknowledgement', async () => {
 const runtime=makeRuntime();
 const calls:string[]=[];
 const events:unknown[]=[];
 runtime.onGoalEvent(e=>events.push(e.params));
 try {
  await runtime.initialize();
  const id=await runtime.openGoalSession({workspaceRoot:process.cwd(),developerInstructions:'test',onRequest:async method=>{calls.push(method);return method==='item/tool/call'?{success:true,contentItems:[]}:{decision:'decline'};}});
  await runtime.setNativeGoal(id,{objective:'test bounded Goal',status:'active'});
  const deadline=Date.now()+2000;
  while(events.length<3 && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.equal(runtime.activeGoalTurn(id),'turn-one');
  assert.equal(calls.filter(c=>c==='item/tool/call').length,1);
  assert.ok(events.some((e:any)=>e.testUnknownRejected===true));
  assert.ok(events.some((e:any)=>e.testApprovalDenied===true));
  await runtime.pauseNativeGoal(id);
  assert.equal(runtime.activeGoalTurn(id),undefined);
  assert.equal((await runtime.getNativeGoal(id))?.status,'paused');
  await assert.rejects(runtime.setNativeGoal('foreign',{status:'active'}),/Unknown/);
  await assert.rejects(runtime.setNativeGoal(id,{objective:' '}),/1 to 4000/);
  await assert.rejects(runtime.setNativeGoal(id,{tokenBudget:-1}),/positive/);
 } finally {await runtime.close();}
});
test('Goal integration is opt-in and does not grant default access', async()=>{
 const runtime=makeRuntime(false);
 try {await runtime.initialize(); await assert.rejects(runtime.openGoalSession({workspaceRoot:process.cwd(),developerInstructions:'test',onRequest:async()=>({})}),/disabled/);} finally {await runtime.close();}
});

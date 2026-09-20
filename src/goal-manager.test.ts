import assert from 'node:assert/strict';
import test from 'node:test';
import {Result} from 'better-result';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalManager} from './goal-manager.js';
import {LocalAgentRuntimePool} from './local-agent-runtime-pool.js';
import type {LocalAgentRuntime} from './local-agent-runtime.js';
import type {CodexGoalSession,NativeGoal} from './local-agent-codex.js';
import type {GoalShrimpClient} from './goal-shrimp-client.js';

test('concurrent starts have one writer; pause fences startup and late tool callbacks',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'goal-lifecycle-'))),projectPath=join(root,'project'),dataRootPath=join(root,'data');
  await mkdir(projectPath);await mkdir(dataRootPath);
  const project=await realpath(projectPath),dataRoot=await realpath(dataRootPath);
  let releaseOpen!:()=>void;const openGate=new Promise<void>(r=>{releaseOpen=r;});
  let sessions=0,shrimpConnects=0,writes=0,activeCalls=0,closed=false,session:CodexGoalSession|undefined;
  let native:NativeGoal={threadId:'test-native-thread',objective:'Create a document',status:'paused',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0};
  const runtime={isAlive:()=>!closed,processId:()=>undefined,onGoalEvent:()=>()=>{},
    openGoalSession:async(s:CodexGoalSession)=>{session=s;sessions++;await openGate;return native.threadId;},
    setNativeGoal:async(_id:string,p:Partial<NativeGoal>)=>{if(p.status==='active')activeCalls++;native={...native,...p};return native;},
    getNativeGoal:async()=>native,pauseNativeGoal:async()=>{native.status='paused';return native;},activeGoalTurn:()=>undefined,
    releaseSession:async()=>{},close:async()=>{closed=true;},run:async()=>{throw new Error('unused');}};
  const pool=new LocalAgentRuntimePool();
  const manager=new GoalManager({stateDir:join(root,'state'),config:{enabled:true,dataRoot,shrimpEntryPoint:join(root,'original-shrimp.js')},pool,
    authorize:async p=>{assert.equal(p.toLowerCase(),project.toLowerCase());},
    driver:{provider:'codex',runtimeKey:c=>c.agentId,createRuntime:async()=>Result.ok(runtime as unknown as LocalAgentRuntime)},
    createShrimp:o=>({connect:async()=>{shrimpConnects++;await writeFile(join(o.dataDir,'tasks.json'),'{"tasks":[]}');},
      call:async(name:string)=>{if(name!=='list_tasks')writes++;return {};},listTools:()=>[],snapshot:async()=>({tasks:[],hash:'empty',commit:null}),close:async()=>{},
    } as unknown as GoalShrimpClient),
  });
  const request={action:'start' as const,ownerRef:'test-owner',workspaceRoot:project,requestKey:'same-operation',spec:{objective:'Create a document',successCriteria:'Document exists',constraints:''}};
  try {
    const replies=await Promise.all(Array.from({length:6},()=>manager.goal(request)));
    assert.ok(replies.every(r=>r.ok));assert.equal(new Set(replies.map(r=>r.data!.goalRef)).size,1);
    const goalRef=String(replies[0].data!.goalRef);
    await until(()=>sessions===1);
    let status=await manager.goal({action:'status',ownerRef:'test-owner',goalRef});
    const paused=await manager.goal({action:'pause',ownerRef:'test-owner',goalRef,requestKey:'pause',expectedRevision:Number(status.data!.revision)});
    assert.equal(paused.data!.controlState,'pause_requested');
    releaseOpen();
    await until(async()=>{status=await manager.goal({action:'status',ownerRef:'test-owner',goalRef});return status.data!.controlState==='paused';});
    assert.equal(sessions,1);assert.equal(shrimpConnects,1);assert.equal(activeCalls,0);assert.equal(closed,true);
    const late=await session!.onRequest('item/tool/call',{tool:'execute_task',arguments:{taskId:'late'}});
    assert.match(JSON.stringify(late),/GOAL_PAUSED/);assert.equal(writes,0);
    const other=await manager.goal({action:'status',ownerRef:'not-owner',goalRef});assert.equal(other.error?.code,'GOAL_NOT_FOUND');
    const corruptResume=manager.store.get('test-owner',goalRef);
    manager.store.observe(corruptResume,{observedAt:new Date().toISOString(),daemonPid:0,proofs:{},cleanShutdown:false});
    const resumed=await manager.goal({action:'resume',ownerRef:'test-owner',goalRef,requestKey:'resume',expectedRevision:Number(status.data!.revision)});
    assert.equal(resumed.error?.code,'RECONCILIATION_REQUIRED');
  }finally{releaseOpen();await manager.close();await pool.close();await rm(root,{recursive:true,force:true});}
});
async function until(fn:()=>boolean|Promise<boolean>) {
  const end=Date.now()+5000;while(!(await fn())){if(Date.now()>end)throw new Error('Test timed out');await new Promise(r=>setTimeout(r,10));}
}

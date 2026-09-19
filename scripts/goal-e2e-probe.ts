import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { CodexAppServerRuntime, type CodexEvent } from '../src/local-agent-codex.js';
import { GoalShrimpClient, nextShrimpTask, type ShrimpTask } from '../src/goal-shrimp-client.js';

const base = 'D:/DevSpace-Goal-PoC/.poc/replan-v1';
const dataRoot = 'D:/AgentState/_poc/shrimp/replan-v1';
const runId = process.argv[2];
if (!/^run-[a-z0-9-]+$/.test(runId ?? '')) throw new Error('Unique run id required');
const workspace = join(base,'fixture',runId);
const evidence = join(base,'evidence',runId);
const dataDir = join(dataRoot,runId);
if ([workspace,evidence,dataDir].some(existsSync)) throw new Error('Refusing to overwrite existing run');
for (const p of [workspace,evidence,dataDir]) mkdirSync(p,{recursive:true});
const node = 'D:/DevSpace/node-v24.20.0-win-x64/node.exe';
const codex = process.env.POC_CODEX_EXE!;
if (!codex || !existsSync(codex)) throw new Error('Verified POC_CODEX_EXE required');
const oldState = 'D:/AgentState/_poc/shrimp/tasks.json';
const oldHash = hash(readFileSync(oldState));
const calls: Array<{ name:string; taskId?:unknown; turnId:unknown }> = [];
const checkpoints: unknown[] = [];
const events: CodexEvent[] = [];
const checks: Record<string,boolean> = {};
let threadId: string | undefined;
let phase = 1;
let pauseRequested = false;
let firstCompletionTurn: unknown;
let runtime: CodexAppServerRuntime;
let shrimp: GoalShrimpClient;
let failure: string | undefined;

function hash(s: string | Buffer) { return createHash('sha256').update(s).digest('hex'); }
function record(kind:string,data:unknown) { appendFileSync(join(evidence,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),kind,data})+'\n'); console.log(JSON.stringify({kind,data})); }
function git(...args:string[]) { return execFileSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim(); }
git('init');
// Independent tests live outside the model's writable workspace.
const spec: Record<string,string> = {
  'Task A': `import assert from 'node:assert/strict'; import {normalizeText} from '${new URL('file:///'+workspace.replaceAll('\\','/')+'/normalize.mjs').href}'; assert.equal(normalizeText('  Hello\\t World\\n'),'Hello World'); assert.equal(normalizeText(''),''); assert.equal(normalizeText('你好   世界'),'你好 世界'); console.log('A verified');`,
  'Task B': `import assert from 'node:assert/strict'; import {countWords} from '${new URL('file:///'+workspace.replaceAll('\\','/')+'/words.mjs').href}'; assert.equal(countWords('  one  two\\nthree '),3); assert.equal(countWords(''),0); assert.equal(countWords('   '),0); console.log('B verified');`,
  'Task C': `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {analyzeText} from '${new URL('file:///'+workspace.replaceAll('\\','/')+'/index.mjs').href}'; assert.deepEqual(analyzeText('  hello   world  '),{normalized:'hello world',words:2}); assert.deepEqual(analyzeText(''),{normalized:'',words:0}); assert.ok(readFileSync('${workspace.replaceAll('\\','/')}/README.md','utf8').includes('analyzeText')); console.log('C verified');`,
};
for (const [name,code] of Object.entries(spec)) writeFileSync(join(evidence,name.replace(' ','-')+'.test.mjs'),code);
async function verify(task: ShrimpTask) {
  const specFile = join(evidence, task.name.replace(' ','-')+'.test.mjs');
  const expected = spec[task.name];
  if (!expected || readFileSync(specFile,'utf8') !== expected) throw new Error('VERIFICATION_FAILED: independent tests changed or missing');
  const output = execFileSync(node,['--test',specFile],{cwd:workspace,encoding:'utf8',windowsHide:true,timeout:20000});
  if (task.name === 'Task A' && !existsSync(join(evidence,'one-off-receipt.json'))) throw new Error('VERIFICATION_FAILED: one-off receipt missing');
  // The supervisor, not model-supplied commands, records the green code checkpoint.
  git('add','--','.');
  if (git('status','--porcelain')) git('-c','user.name=DevSpace PoC','-c','user.email=poc@localhost','commit','-m',`test: verified ${task.name}`);
  const receipt = {taskId:task.id,name:task.name,codeCommit:git('rev-parse','HEAD'),testHash:hash(expected),exitCode:0,output};
  writeFileSync(join(evidence,task.id+'-verification.json'),JSON.stringify(receipt,null,2));
  checkpoints.push(receipt);
  record('verified',{name:task.name,codeCommit:receipt.codeCommit});
}
function makeShrimp(initializeEmpty=false) { return new GoalShrimpClient({command:node,entryPoint:'D:/DevSpace-Goal-PoC/dist/index.js',workspaceRoot:workspace,dataDir,allowedDataRoot:dataRoot,initializeEmpty,verifyEvidence:verify}); }
function makeRuntime() {
  const r = new CodexAppServerRuntime({command:codex,env:process.env,enableGoalApi:true,version:'0.153.4'});
  r.onGoalEvent(event => {
    events.push(event);
    if (event.method === 'turn/started' || event.method === 'turn/completed') record(event.method,event.params);
  });
  return r;
}
async function onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method !== 'item/tool/call') { record('approval-or-unsupported',{method}); throw new Error('No approval granted by test supervisor.'); }
  const name = String(params.tool);
  const args = params.arguments as Record<string,unknown>;
  if (name === 'next_task') {
    const state = await shrimp.snapshot();
    const next = pauseRequested ? null : nextShrimpTask(state.tasks);
    return content({next,pauseRequested,allCompleted:state.tasks.length===3 && state.tasks.every(t=>t.status==='completed')});
  }
  if (pauseRequested) return content({error:'Test pause requested. End this turn without further work.'},false);
  if (name === 'record_once') {
    if (phase !== 1 || args.key !== 'A') return content({error:'Not authorized for this task'},false);
    const path = join(evidence,'one-off-receipt.json');
    const receipt = {key:'A',at:new Date().toISOString(),turnId:params.turnId};
    if (existsSync(path)) return content({alreadyApplied:true,receipt:JSON.parse(readFileSync(path,'utf8'))});
    writeFileSync(path,JSON.stringify(receipt),{flag:'wx'});
    record('one-off-applied',receipt);
    return content(receipt);
  }
  calls.push({name,taskId:args.taskId,turnId:params.turnId});
  try {
    const result = await shrimp.call(name,args);
    if (name === 'verify_task') {
      const state = await shrimp.snapshot();
      const completed = state.tasks.find(t=>t.id===args.taskId);
      if (completed?.status === 'completed') {
        const link = {taskId:completed.id,stateCommit:state.commit,stateHash:state.hash,codeCommit:git('rev-parse','HEAD')};
        checkpoints.push(link);
        record('checkpoint',link);
        if (phase === 1 && completed.name === 'Task A') {
          pauseRequested = true;
          firstCompletionTurn = params.turnId;
          await runtime.setNativeGoal(threadId!,{status:'paused'});
          return content({result,pauseRequested:true,instruction:'Checkpoint A is complete. End this turn now. Do not execute B yet.'});
        }
      }
    }
    return content(result);
  } catch (error) { record('tool-error',{name,message:(error as Error).message}); return content({error:(error as Error).message},false); }
}
function content(value: unknown, success=true) { return {success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]}; }
async function until(fn:()=>boolean, timeout=360000) {
  const deadline=Date.now()+timeout;
  while (!fn()) { if (!runtime.isAlive()) throw new Error('Runtime exited'); if(Date.now()>deadline) throw new Error('Bounded acceptance timeout'); await new Promise(r=>setTimeout(r,300)); }
}
const instructions = 'Use only this isolated project. No external apps, subagents, installs, or networking. Implement the three preseeded tasks through next_task and the provided Shrimp tools. Use apply_patch for code edits. Call execute_task before doing each task; call verify_task after actual implementation. The supervisor independently runs tests before accepting completion. Exactly one task per native turn; end the turn after each verified task so native Goal performs continuation. Never clear, delete, or replan tasks. Never modify .git or run Git commands; supervisor owns checkpoints. For A call record_once with key A once. Respect pauseRequested immediately and end that turn. On resume do not redo completed tasks or one-off action. When next_task confirms allCompleted, mark native Goal complete. Tool name complete_task does not exist.';
try {
  shrimp = makeShrimp(true); await shrimp.connect();
  await shrimp.call('list_tasks',{status:'all'});
  const tools = shrimp.listTools();
  writeFileSync(join(evidence,'shrimp-tools.json'),JSON.stringify(tools,null,2));
  const other = makeShrimp();
  await assert.rejects(other.connect(),/GOAL_BUSY/); checks.secondWriterBlocked=true;
  await shrimp.call('split_tasks',{updateMode:'append',globalAnalysisResult:`Goal ${runId}; original Shrimp; real code and independent verification.`,tasksRaw:JSON.stringify([
    {name:'Task A',description:'Create normalize.mjs exporting normalizeText: trim text and collapse all whitespace to single spaces; empty stays empty. Record one-off A receipt once with record_once.',implementationGuide:'Export pure function normalizeText from normalize.mjs; call record_once key A.',dependencies:[]},
    {name:'Task B',description:'Create words.mjs exporting countWords using normalizeText; empty or whitespace-only is zero; count space-separated tokens.',implementationGuide:'Import normalizeText from ./normalize.mjs; export countWords.',dependencies:['Task A']},
    {name:'Task C',description:'Create index.mjs exporting analyzeText returning {normalized,words}; import prior functions. Add README.md documenting analyzeText and usage.',implementationGuide:'Compose normalizeText and countWords; document analyzeText with an example.',dependencies:['Task B']},
  ])});
  const seeded=await shrimp.snapshot();
  checks.threeDependencies=seeded.tasks.length===3 && seeded.tasks[1].dependencies[0].taskId===seeded.tasks[0].id && seeded.tasks[2].dependencies[0].taskId===seeded.tasks[1].id;
  await assert.rejects(shrimp.call('execute_task',{taskId:seeded.tasks[1].id}),/DEPENDENCY_INVALID/); checks.prematureBRejected=true;
  runtime=makeRuntime(); await runtime.initialize();
  threadId=await runtime.openGoalSession({workspaceRoot:workspace,writeMode:'allowed',developerInstructions:instructions,dynamicTools:[
    ...tools.map(t=>({name:t.name,description:t.description??t.name,inputSchema:t.inputSchema as Record<string,unknown>})),
    {name:'next_task',description:'Read the unique next executable task or completed/pause status.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
    {name:'record_once',description:'Record the independent one-off A side effect, only for Task A.',inputSchema:{type:'object',properties:{key:{type:'string',enum:['A']}},required:['key'],additionalProperties:false}},
  ],onRequest});
  writeFileSync(join(evidence,'binding.json'),JSON.stringify({threadId,workspace,dataDir,runId,schedulingMode:'native'},null,2));
  await runtime.setNativeGoal(threadId,{objective:'Complete preseeded Task A then B then C in the isolated text utility project. Use next_task and Shrimp task tools. Implement real modules and README, pass independent tests. One task per turn, then end turn for native continuation. Obey checkpoint pause after A; on resume never repeat A. All three verified tasks are required.',status:'active'});
  await until(()=>Boolean(firstCompletionTurn) && events.some(e=>e.method==='turn/completed' && (e.params as any).turn?.id===firstCompletionTurn));
  await runtime.pauseNativeGoal(threadId);
  const afterA=await shrimp.snapshot();
  checks.aCompleted=afterA.tasks[0].status==='completed';
  const aJson=JSON.stringify(afterA.tasks[0]);
  const receiptHash=hash(readFileSync(join(evidence,'one-off-receipt.json')));
  await runtime.close(); await shrimp.close();
  record('process-boundary',{action:'closed both owned Codex and Shrimp processes after real A checkpoint'});
  shrimp=makeShrimp(); await shrimp.connect();
  const restarted=await shrimp.snapshot();
  checks.resumeNextIsB=nextShrimpTask(restarted.tasks)?.name==='Task B';
  checks.aStateUnchanged=JSON.stringify(restarted.tasks[0])===aJson;
  runtime=makeRuntime(); await runtime.initialize(); phase=2; pauseRequested=false;
  await runtime.openGoalSession({threadId,workspaceRoot:workspace,writeMode:'allowed',developerInstructions:instructions,onRequest});
  checks.nativeGoalPersisted=(await runtime.getNativeGoal(threadId))?.status==='paused';
  await runtime.setNativeGoal(threadId,{status:'active'});
  await until(()=>events.some(e=>e.method==='thread/goal/updated' && (e.params as any).goal?.status==='complete'));
  await until(()=>runtime.activeGoalTurn(threadId!)===undefined);
  const final=await shrimp.snapshot();
  checks.allThreeRealTasksComplete=final.tasks.length===3 && final.tasks.every(t=>t.status==='completed');
  checks.aNeverExecutedAgain=calls.filter(c=>c.name==='execute_task' && c.taskId===afterA.tasks[0].id).length===1;
  checks.oneOffNotRepeated=hash(readFileSync(join(evidence,'one-off-receipt.json')))===receiptHash;
  checks.restoredDynamicTools=calls.some(c=>c.name==='verify_task' && c.taskId===final.tasks[2].id);
  checks.separateNativeTaskTurns=new Set(calls.filter(c=>c.name==='verify_task').map(c=>c.turnId)).size>=3;
  for(const task of final.tasks) await verify(task);
  writeFileSync(join(evidence,'final-task-snapshot.json'),JSON.stringify(final,null,2));
  assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
} catch(error) { failure=(error as Error).message; record('failure',{message:failure}); process.exitCode=1; }
finally {
  if (threadId! && runtime!?.isAlive() && (await runtime.getNativeGoal(threadId).catch(()=>null))?.status === 'active') await runtime.pauseNativeGoal(threadId).catch(()=>{});
  if (runtime!) await runtime.close();
  if (shrimp!) await shrimp.close().catch(e=>{failure??=String(e);});
  checks.oldPoCUnchanged=hash(readFileSync(oldState))===oldHash;
  const result={runId,threadId:threadId!,checks,failure,calls,checkpoints,result:failure?'FAIL':'PASS',note:'Local integration test only; not deployed and no actual Web acceptance yet.'};
  writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({evidence,...result}));
}

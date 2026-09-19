import { mkdir, readdir, realpath, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { captureAgentProviderResult } from "./local-agent-errors.js";
import { CodexAppServerRuntime, codexCommandEnvironment, resolveCodexCommand, type CodexEvent, type NativeGoal } from "./local-agent-codex.js";
import { GoalBindingStore, type GoalBinding, type GoalControlState } from "./goal-binding-store.js";
import { GoalShrimpClient, nextShrimpTask, type ShrimpTask, type ShrimpClientOptions } from "./goal-shrimp-client.js";
import { goalError, goalRequestSchema, goalSpecSchema, type GoalApi, type GoalRequest, type GoalReply, type GoalSpec, type ManagedGoalConfig } from "./goal-contracts.js";
import { LocalAgentRuntimePool, type LocalAgentRuntimeHold } from "./local-agent-runtime-pool.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";
import { projectGit, readGoalTasks, scopedArtifacts, sha256, type ArtifactEvidence } from "./goal-evidence.js";

interface Proof { taskId:string; artifacts:ArtifactEvidence[]; commandId?:string; verification:"artifact_hashes"|"artifact_hashes_and_command_exit"; recordedAt:string; projectCommit?:string; taskCommit?:string|null; taskHash?:string }
interface Observation extends Record<string,unknown> {
  observedAt:string; nativeGoal?:NativeGoal|null; nativePid?:number; daemonPid:number;
  cleanShutdown?:boolean; error?:{code:string;message:string}; pendingDecision?:{method:string;message:string};
  proofs:Record<string,Proof>; gitConfigHash?:string;
}
interface LiveGoal {
  binding:GoalBinding; spec:GoalSpec; observation:Observation;
  runtime?:CodexAppServerRuntime; shrimp?:GoalShrimpClient; hold?:LocalAgentRuntimeHold;
  opening?:Promise<void>; transition?:Promise<void>; unsubscribe?:()=>void; closing?:Promise<void>;
  commands:Map<string,{exitCode:number}>; noProgress:number; lastHash?:string; check?:Promise<void>;
  failing?:boolean;
}
export interface GoalManagerOptions {
  stateDir:string; config:ManagedGoalConfig; pool:LocalAgentRuntimePool;
  /** Re-evaluates durable authorization; no caller-supplied grants or temporary conversation scope. */
  authorize:(workspaceRoot:string)=>Promise<void>;
  env?:NodeJS.ProcessEnv;
  driver?:LocalAgentDriver;
  createShrimp?:(options:ShrimpClientOptions)=>GoalShrimpClient;
}

/** Lifecycle adapter in the existing daemon. Native Codex is the only turn scheduler. */
export class GoalManager implements GoalApi {
  readonly store:GoalBindingStore;
  private readonly live=new Map<string,LiveGoal>();
  private closing=false;
  constructor(private readonly options:GoalManagerOptions) { this.store=new GoalBindingStore(options.stateDir); }
  get activeCount():number { return this.live.size; }

  async goal(raw:GoalRequest):Promise<GoalReply> {
    try {
      if(this.closing)throw new Error("GOAL_UNAVAILABLE: daemon is shutting down.");
      const request=goalRequestSchema.parse(raw);
      if(request.action==='start')return {ok:true,data:await this.start(request)};
      if(request.action==='list') {
        const goals:Record<string,unknown>[]=[];
        for(const b of this.store.all(request.ownerRef)) {
          if(request.workspaceRoot && resolve(request.workspaceRoot).toLowerCase()!==b.workspaceRoot.toLowerCase())continue;
          try { await this.options.authorize(b.workspaceRoot); goals.push(await this.status(b)); } catch { /* Do not disclose no-longer-authorized projects. */ }
        }
        return {ok:true,data:{goals}};
      }
      let binding=this.store.get(request.ownerRef,request.goalRef);
      // Owner-authenticated pause/stop remain available even after project access is revoked.
      if(request.action==='pause'||request.action==='stop') {
        if(binding.controlState==='stopped'||binding.controlState==='completed')return {ok:true,data:await this.status(binding,false)};
        binding=this.store.control({ownerRef:request.ownerRef,goalRef:request.goalRef,requestKey:request.requestKey,
          expectedRevision:request.expectedRevision,expectedEpoch:binding.ownerEpoch,
          state:request.action==='pause'?'pause_requested':'stop_requested'});
        const live=this.live.get(binding.goalRef);
        if(live) {
          live.binding=binding;
          live.transition ??= this.quiesce(live,request.action==='stop'?'stopped':'paused').finally(()=>{live.transition=undefined;});
        } else {
          const prior=this.observation(binding);
          if(prior.cleanShutdown===true || !binding.providerSessionId)binding=this.change(binding,request.action==='stop'?'stopped':'paused');
          else throw new Error("RECONCILIATION_REQUIRED: runtime ownership is unconfirmed; no stop acknowledgement yet.");
        }
        return {ok:true,data:await this.status(this.store.get(binding.ownerRef,binding.goalRef),false)};
      }
      await this.options.authorize(binding.workspaceRoot);
      if(request.action==='status')return {ok:true,data:await this.status(binding)};
      if(request.action==='resume') {
        const current=this.live.get(binding.goalRef);
        if(current?.transition)throw new Error("GOAL_BUSY: wait until pause or stop is acknowledged.");
        if(binding.creationPhase!=='bound'||!binding.providerSessionId)throw new Error("RECONCILIATION_REQUIRED: native thread creation is unresolved.");
        if(!current && this.observation(binding).cleanShutdown!==true)throw new Error("RECONCILIATION_REQUIRED: prior runtime exit is unconfirmed; automatic replay is disabled.");
        binding=this.store.control({ownerRef:request.ownerRef,goalRef:binding.goalRef,requestKey:request.requestKey,
          expectedRevision:request.expectedRevision,expectedEpoch:binding.ownerEpoch,state:'running'});
        if(current) {current.binding=binding;return {ok:true,data:await this.status(binding)};}
        const live=this.newLive(binding);
        this.launch(live,false);
        return {ok:true,data:await this.status(binding)};
      }
      throw new Error("GOAL_OPERATION_FAILED: unsupported action.");
    } catch(error) { return goalError(error); }
  }

  private async start(r:Extract<GoalRequest,{action:'start'}>):Promise<Record<string,unknown>> {
    const root=await realpath(r.workspaceRoot);
    if(root.toLowerCase()!==resolve(r.workspaceRoot).toLowerCase())throw new Error("WORKSPACE_ACCESS_REQUIRED: alias workspaces are not supported.");
    await this.options.authorize(root);
    const existing=this.store.all(r.ownerRef).find(b=>b.creationRequestKey===r.requestKey);
    const dataRoot=await realpath(this.options.config.dataRoot);
    if(!isAbsolute(this.options.config.dataRoot)||!isAbsolute(this.options.config.shrimpEntryPoint))throw new Error("GOAL_CAPABILITY_UNAVAILABLE: absolute installation paths required.");
    const inside=(a:string,b:string)=>{const rel=relative(a,b);return !rel||(!rel.startsWith('..')&&!isAbsolute(rel));};
    if(inside(root,dataRoot)||inside(dataRoot,root))throw new Error("GOAL_CAPABILITY_UNAVAILABLE: task data and project must be separate trees.");
    const dataDir=join(dataRoot,sha256(`${r.ownerRef}\0${r.requestKey}`));
    const entries=existing?[]:await readdir(root);
    // Recheck after filesystem awaits: two concurrent retries must not launch two writers.
    const existingAfterRead=this.store.all(r.ownerRef).find(b=>b.creationRequestKey===r.requestKey);
    if(!existingAfterRead && entries.length)throw new Error("WORKSPACE_NOT_EMPTY: preview Goals require a dedicated empty project; resume existing Goals by ID.");
    let binding=this.store.prepare({ownerRef:r.ownerRef,workspaceRoot:root,dataDir,requestKey:r.requestKey,spec:r.spec});
    if(existingAfterRead||binding.creationPhase!=='prepared'||this.live.has(binding.goalRef))return this.status(binding);
    binding=this.store.phase(binding,'creating');
    const live=this.newLive(binding);
    this.launch(live,true);
    return this.status(binding);
  }
  private newLive(binding:GoalBinding):LiveGoal {
    const live:LiveGoal={binding,spec:goalSpecSchema.parse(this.store.metadata(binding.ownerRef,binding.goalRef).spec),
      observation:this.observation(binding),commands:new Map(),noProgress:0};
    this.live.set(binding.goalRef,live);return live;
  }
  private observation(b:GoalBinding):Observation {
    return (this.store.metadata(b.ownerRef,b.goalRef).observation as Observation|null)
      ?? {observedAt:new Date().toISOString(),daemonPid:process.pid,proofs:{}};
  }
  private save(live:LiveGoal):void {
    live.observation.observedAt=new Date().toISOString();
    this.store.observe(live.binding,live.observation);
  }
  private change(b:GoalBinding,state:GoalControlState):GoalBinding {
    return this.store.control({ownerRef:b.ownerRef,goalRef:b.goalRef,expectedRevision:b.revision,
      expectedEpoch:b.ownerEpoch,requestKey:`internal:${randomUUID()}`,state});
  }
  private launch(live:LiveGoal,fresh:boolean):void {
    live.opening=this.open(live,fresh).catch(error=>this.fail(live,error));
  }
  private async open(live:LiveGoal,fresh:boolean):Promise<void> {
    const b=live.binding;
    await this.options.authorize(b.workspaceRoot);
    if(fresh) {
      await mkdir(b.dataDir); // exclusive creation; an existing directory is never treated as empty
      projectGit(b.workspaceRoot,'init');
      live.observation.gitConfigHash=sha256(await readFile(join(b.workspaceRoot,'.git','config')));
    }
    live.observation.cleanShutdown=false;live.observation.daemonPid=process.pid;
    delete live.observation.error;delete live.observation.pendingDecision;this.save(live);
    const shrimp=(this.options.createShrimp??(o=>new GoalShrimpClient(o)))({command:process.execPath,entryPoint:this.options.config.shrimpEntryPoint,
      workspaceRoot:b.workspaceRoot,dataDir:b.dataDir,allowedDataRoot:this.options.config.dataRoot,initializeEmpty:fresh,
      authorizeWrite:()=>this.assertWritable(live),verifyEvidence:task=>this.verify(live,task)});
    live.shrimp=shrimp;await shrimp.connect();
    await shrimp.call('list_tasks',{status:'all'});
    const env=codexCommandEnvironment(this.options.env??process.env);
    if(this.options.config.codexCommand)env.CODEX_COMMAND=this.options.config.codexCommand;
    const driver=this.options.driver??this.driver(env);
    const held=await this.options.pool.hold(driver,{agentId:b.goalRef,provider:'codex',workspaceRoot:b.workspaceRoot,writeMode:'allowed'});
    if(held.isErr())throw held.error;
    live.hold=held.value;
    const runtime=held.value.runtime as CodexAppServerRuntime;
    if(typeof runtime.openGoalSession!=='function')throw new Error("GOAL_CAPABILITY_UNAVAILABLE: runtime has no native Goal support.");
    live.runtime=runtime;live.observation.nativePid=runtime.processId();this.save(live);
    live.unsubscribe=runtime.onGoalEvent(e=>this.event(live,e));
    const tools=[...shrimp.listTools().map(t=>({name:t.name,description:t.description??t.name,inputSchema:t.inputSchema as Record<string,unknown>})),
      {name:'next_task',description:'Read persisted task state and the unique next task. Empty tasks require split_tasks. Never repeat completed work.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
      {name:'record_task_evidence',description:'Record actual non-empty project artifact paths before verify_task. Optional successful commandId must be from this native turn. Hash verification is not human acceptance.',inputSchema:{type:'object',properties:{taskId:{type:'string'},paths:{type:'array',items:{type:'string'},minItems:1,maxItems:30},commandId:{type:'string'}},required:['taskId','paths'],additionalProperties:false}},
    ];
    const threadId=await runtime.openGoalSession({threadId:b.providerSessionId??undefined,workspaceRoot:b.workspaceRoot,
      writeMode:'allowed',developerInstructions:this.instructions(live),dynamicTools:tools,onRequest:(m,p)=>this.onRequest(live,m,p)});
    await held.value.bindSession(threadId);
    let latest=this.store.get(b.ownerRef,b.goalRef);
    if(!latest.providerSessionId)latest=this.store.bind(b.ownerRef,b.goalRef,latest.revision,threadId);
    live.binding=latest;
    if(fresh) live.observation.nativeGoal=await runtime.setNativeGoal(threadId,{objective:live.spec.objective,status:'paused',
      ...(live.spec.tokenBudget?{tokenBudget:live.spec.tokenBudget}:{})});
    else live.observation.nativeGoal=await runtime.getNativeGoal(threadId);
    latest=this.store.get(b.ownerRef,b.goalRef);
    if(latest.controlState==='pause_requested'||latest.controlState==='stop_requested') {live.binding=latest;this.save(live);return;}
    await this.options.authorize(b.workspaceRoot);
    live.binding=latest.controlState==='running'?latest:this.change(latest,'running');
    await this.assertWritable(live);
    live.observation.nativeGoal=await runtime.setNativeGoal(threadId,{status:'active'});
    this.save(live);
  }
  private driver(env:NodeJS.ProcessEnv):LocalAgentDriver {
    return {provider:'codex',runtimeKey:c=>`managed-goal:${c.agentId}`,idleTimeoutMs:0,
      createRuntime:()=>captureAgentProviderResult({provider:'codex',operation:'goal_runtime',run:async()=>{
        const command=resolveCodexCommand(env);
        if(!command)throw new Error("GOAL_CAPABILITY_UNAVAILABLE: supported signed-in Codex runtime is unavailable.");
        const runtime=new CodexAppServerRuntime({command:command.executable,env,version:command.version,enableGoalApi:true});
        try {await runtime.initialize();return runtime;}catch(error){await runtime.close();throw error;}
      }})};
  }
  private async assertWritable(live:LiveGoal):Promise<void> {
    const b=this.store.get(live.binding.ownerRef,live.binding.goalRef);
    if(this.closing||b.ownerEpoch!==live.binding.ownerEpoch||b.controlState!=='running'||live.closing)throw new Error("GOAL_PAUSED: writes are fenced by current control state.");
    await this.options.authorize(b.workspaceRoot);
  }
  private async verify(live:LiveGoal,task:ShrimpTask):Promise<void> {
    const proof=live.observation.proofs[task.id];
    if(!proof)throw new Error("VERIFICATION_FAILED: record actual artifact evidence first.");
    const current=await scopedArtifacts(live.binding.workspaceRoot,proof.artifacts.map(a=>a.path));
    if(JSON.stringify(current)!==JSON.stringify(proof.artifacts))throw new Error("VERIFICATION_FAILED: artifacts changed since evidence collection.");
    await this.assertWritable(live);
    if(sha256(await readFile(join(live.binding.workspaceRoot,'.git','config')))!==live.observation.gitConfigHash)throw new Error("RECONCILIATION_REQUIRED: managed Git configuration changed.");
    await this.assertWritable(live);
    projectGit(live.binding.workspaceRoot,'add','--',...proof.artifacts.map(a=>a.path));
    if(projectGit(live.binding.workspaceRoot,'diff','--cached','--name-only'))projectGit(live.binding.workspaceRoot,'commit','-m',`goal: verified artifacts ${task.id}`);
    proof.projectCommit=projectGit(live.binding.workspaceRoot,'rev-parse','HEAD');
    this.save(live);
  }
  private async onRequest(live:LiveGoal,method:string,p:Record<string,unknown>):Promise<unknown> {
    if(method!=='item/tool/call') {
      live.observation.pendingDecision={method,message:'Additional native approval or user input is required. No approval was granted; work is paused.'};
      this.save(live);
      // Reject first so the native turn can converge; never translate model text into a user approval.
      setTimeout(()=>{void this.fail(live,new Error('NATIVE_APPROVAL_REQUIRED: additional local approval is not connected in this preview.'));},0);
      if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval')return {decision:'cancel'};
      throw new Error('NATIVE_APPROVAL_REQUIRED');
    }
    try {
      const name=String(p.tool), args=p.arguments as Record<string,unknown>;
      if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Invalid tool arguments.');
      const shrimp=live.shrimp!;
      if(name==='next_task') {
        const state=await shrimp.snapshot(), b=this.store.get(live.binding.ownerRef,live.binding.goalRef);
        return content({tasks:state.tasks,next:b.controlState==='running'?nextShrimpTask(state.tasks):null,
          controlState:b.controlState,needsPlan:state.tasks.length===0,allCompleted:state.tasks.length>0&&state.tasks.every(t=>t.status==='completed')});
      }
      await this.assertWritable(live);
      if(name==='record_task_evidence') {
        const taskId=String(args.taskId), state=await shrimp.snapshot();
        if(nextShrimpTask(state.tasks)?.id!==taskId||!state.tasks.some(t=>t.id===taskId&&t.status==='in_progress'))throw new Error('VERIFICATION_FAILED: evidence must belong to the current in-progress task.');
        if(!Array.isArray(args.paths)||!args.paths.every(p=>typeof p==='string'))throw new Error('Invalid artifact paths.');
        const commandId=args.commandId===undefined?undefined:String(args.commandId);
        if(commandId&&live.commands.get(commandId)?.exitCode!==0)throw new Error('VERIFICATION_FAILED: no matching successful native command event.');
        const proof:Proof={taskId,artifacts:await scopedArtifacts(live.binding.workspaceRoot,args.paths as string[]),
          commandId,verification:commandId?'artifact_hashes_and_command_exit':'artifact_hashes',recordedAt:new Date().toISOString()};
        await this.assertWritable(live);live.observation.proofs[taskId]=proof;this.save(live);return content(proof);
      }
      const result=await shrimp.call(name,args);
      if(name==='verify_task') {
        const state=await shrimp.snapshot(),proof=live.observation.proofs[String(args.taskId)];
        if(proof&&state.tasks.some(t=>t.id===args.taskId&&t.status==='completed')) {proof.taskCommit=state.commit;proof.taskHash=state.hash;this.save(live);}
      }
      return content(result);
    } catch(error) {
      const reply=goalError(error);
      if(/RECONCILIATION_REQUIRED|TASK_STATE_CORRUPT/.test(reply.error!.code))setTimeout(()=>{void this.fail(live,error);},0);
      return content(reply,false);
    }
  }
  private event(live:LiveGoal,e:CodexEvent):void {
    const p=e.params as Record<string,any>;
    if(e.method==='thread/goal/updated') {
      live.observation.nativeGoal=p.goal;this.save(live);
      if(p.goal?.status==='complete'&&!live.runtime?.activeGoalTurn(live.binding.providerSessionId??'')&&!live.closing&&!live.transition)
        live.check ??= this.afterTurn(live).catch(error=>this.fail(live,error)).finally(()=>{live.check=undefined;});
    }
    if(e.method==='item/completed'&&p.item?.type==='commandExecution'&&typeof p.item.id==='string'&&p.item.exitCode===0) {
      live.commands.set(p.item.id,{exitCode:0});if(live.commands.size>100)live.commands.delete(live.commands.keys().next().value!);
    }
    if(e.method==='turn/completed'&&!live.closing&&!live.transition) {
      live.check ??= this.afterTurn(live).catch(error=>this.fail(live,error)).finally(()=>{live.check=undefined;});
    }
  }
  private async afterTurn(live:LiveGoal):Promise<void> {
    if(!live.shrimp||!live.runtime||!live.binding.providerSessionId)return;
    const state=await live.shrimp.snapshot();
    if(state.hash===live.lastHash)live.noProgress++;else live.noProgress=0;
    live.lastHash=state.hash;
    live.observation.nativeGoal=await live.runtime.getNativeGoal(live.binding.providerSessionId);this.save(live);
    if(this.store.get(live.binding.ownerRef,live.binding.goalRef).controlState!=='running')return;
    if(live.observation.nativeGoal?.status==='complete') {
      if(!state.tasks.length||!state.tasks.every(t=>t.status==='completed'&&live.observation.proofs[t.id]?.taskCommit))throw new Error('COMPLETION_UNVERIFIED: native completion lacks persisted task evidence.');
      live.binding=this.change(this.store.get(live.binding.ownerRef,live.binding.goalRef),'completed');
      await this.dispose(live);return;
    }
    if(live.observation.nativeGoal && live.observation.nativeGoal.status!=='active') {await this.quiesce(live,'paused',true);return;}
    if(live.noProgress>=3)throw new Error('NO_PROGRESS: three native turns had no persisted task progress.');
  }
  private async quiesce(live:LiveGoal,finalState:'paused'|'stopped',preserveNative=false):Promise<void> {
    try {
      await live.opening;
      const b=this.store.get(live.binding.ownerRef,live.binding.goalRef);
      if(live.runtime&&b.providerSessionId&&live.runtime.isAlive()) {
        if(!preserveNative||live.runtime.activeGoalTurn(b.providerSessionId))live.observation.nativeGoal=await live.runtime.pauseNativeGoal(b.providerSessionId);
      }
      await this.dispose(live);
      const latest=this.store.get(b.ownerRef,b.goalRef);
      if(latest.controlState!=='stopped'&&latest.controlState!=='completed')live.binding=this.change(latest,latest.controlState==='stop_requested'?'stopped':finalState);
    } catch(error) {live.observation.error=goalError(error).error;this.save(live);}
  }
  private async fail(live:LiveGoal,error:unknown):Promise<void> {
    if(live.closing||live.failing)return;
    live.failing=true;
    live.observation.error=goalError(error).error;this.save(live);
    try {
      let b=this.store.get(live.binding.ownerRef,live.binding.goalRef);
      if(b.controlState==='running')b=this.change(b,'pause_requested');live.binding=b;
      if(live.runtime&&b.providerSessionId&&live.runtime.isAlive())live.observation.nativeGoal=await live.runtime.pauseNativeGoal(b.providerSessionId);
      await this.dispose(live);
      b=this.store.get(b.ownerRef,b.goalRef);
      if(b.creationPhase!=='bound')b=this.store.phase(b,'needs_reconciliation');
      if(b.controlState!=='stopped'&&b.controlState!=='completed')live.binding=this.change(b,b.controlState==='stop_requested'?'stopped':'paused');
    } catch { /* Keep unresolved ownership fenced and visible; never start a replacement blindly. */ }
    finally {live.failing=false;}
  }
  private async dispose(live:LiveGoal):Promise<void> {
    live.closing ??= (async()=>{
      await live.runtime?.close();
      await live.shrimp?.close();
      live.unsubscribe?.();live.hold?.release();
      live.observation.cleanShutdown=true;this.save(live);this.live.delete(live.binding.goalRef);
    })();
    return live.closing;
  }
  private async status(b:GoalBinding,readProject=true):Promise<Record<string,unknown>> {
    const live=this.live.get(b.goalRef),observation=live?.observation??this.observation(b);
    let tasks:ShrimpTask[]=[],taskReadError:string|undefined;
    if(readProject)try {tasks=(await readGoalTasks(b.dataDir)).tasks;}catch(error){taskReadError=(error as NodeJS.ErrnoException).code==='ENOENT'?'TASKS_NOT_CREATED':goalError(error).error!.code;}
    let nextTask:ShrimpTask|null=null;
    try {if(tasks.length)nextTask=nextShrimpTask(tasks);}catch{taskReadError='DEPENDENCY_INVALID';}
    return {goalRef:b.goalRef,threadId:b.providerSessionId,workspaceRoot:readProject?b.workspaceRoot:undefined,
      phase:b.creationPhase,controlState:b.controlState,revision:b.revision,nativeGoal:observation.nativeGoal??null,
      runtimeConnected:!!live?.runtime?.isAlive(),activeTurnId:live?.runtime?.activeGoalTurn(b.providerSessionId??'')??null,
      observedAt:observation.observedAt,queriedAt:new Date().toISOString(),nativeObservationCached:!live,
      tasks:readProject?tasks.map(t=>({id:t.id,name:t.name,status:t.status,dependencies:t.dependencies})):undefined,
      nextTask:readProject?nextTask?.id??null:undefined,taskReadError,pendingDecision:observation.pendingDecision??null,
      error:observation.error??null,verification:taskReadError?'task_state_not_verified':b.controlState==='completed'?'artifact_checks_recorded_user_acceptance_required':'not_complete',
      checkpoints:readProject?Object.values(observation.proofs):undefined};
  }
  async reconcile():Promise<void> {
    // Called only after the existing daemon lock is acquired. Crash recovery does not imply child death.
    for(const b of this.store.all()) {
      if(b.controlState==='stopped'||b.controlState==='completed')continue;
      const observation=this.observation(b);
      const fenced=this.store.fenceForRecovery(b.ownerRef,b.goalRef,b.revision);
      if(observation.cleanShutdown!==true)this.store.observe(fenced,{...observation,error:{code:'RECONCILIATION_REQUIRED',message:'Previous process exited without confirmed child shutdown. No automatic replay was attempted.'}});
    }
  }
  async maintain():Promise<void> {
    for(const live of this.live.values()) {
      if(live.closing||live.transition||live.failing)continue;
      if(live.runtime&&!live.runtime.isAlive()) {await this.fail(live,new Error('RUNTIME_DISCONNECTED: managed native process exited.'));continue;}
      try {await this.options.authorize(live.binding.workspaceRoot);}catch(error){await this.fail(live,error);}
    }
  }
  async close():Promise<void> {
    this.closing=true;
    for(const live of [...this.live.values()]) {
      let b=this.store.get(live.binding.ownerRef,live.binding.goalRef);
      if(b.controlState==='running')b=this.change(b,'pause_requested');live.binding=b;
      await this.quiesce(live,'paused');
    }
    this.store.close();
  }
  private instructions(live:LiveGoal):string {
    return `This is a user-authorized managed Goal (${live.binding.goalRef}). Work only in this dedicated project. No other projects, external applications, installs, subagents, publishing, account changes, or side effects outside the project are authorized by this preview. Do not edit .git, use Git, access task storage, or create background processes. Native Goal is the only scheduler; never ask the user to say continue.\n`+
      `Success criteria: ${live.spec.successCriteria}\nConstraints: ${live.spec.constraints}\n`+
      `Start every native turn with next_task. If tasks are empty, plan with split_tasks updateMode=append. Make a dependency-ordered plan; never delete or replan completed tasks. Call execute_task before working on the unique next task. Implement real artifacts, run appropriate checks with native tools, then record_task_evidence with relative file paths and optionally the actual successful command item id. Then call verify_task; the manager independently checks hashes and records Git checkpoints. Exactly one task per turn: end the turn after completion so native Goal continues. Never repeat completed tasks after resume. Respect pauses. Only mark the native Goal complete when all persisted tasks are completed with evidence. Artifact checks do not replace the user's final acceptance. If permissions or requirements block work, report the specific issue and mark native Goal blocked.`;
  }
}
function content(value:unknown,success=true) {return {success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]};}

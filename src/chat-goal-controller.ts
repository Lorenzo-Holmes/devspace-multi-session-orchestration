import { randomUUID } from "node:crypto";
import { chatGoalPhase } from "./chat-goal-diagnostics.js";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CHAT_GOAL_BOUNDARIES, chatGoalSpecSchema, type ChatGoalConfig, type ChatGoalSpec, type ChatQuestion } from "./chat-goal-contracts.js";
import { ChatGoalStore, type ChatGoalBinding, type ChatReply } from "./chat-goal-store.js";
import { GoalShrimpClient, nextShrimpTask, type ShrimpTask } from "./goal-shrimp-client.js";
import { projectGit, readGoalTasks, scopedArtifacts, sha256, type ArtifactEvidence } from "./goal-evidence.js";

export interface ChatGoalContext { ownerRef: string; workspaceRoot: string; authorize(): Promise<void> }
interface Mutation { goalRef: string; requestKey: string; expectedRevision: number }
export const chatGoalFailure = (error: unknown): ChatReply => {
  const message = (error instanceof Error ? error.message : "Chat Goal operation failed").slice(0,1000);
  return {ok:false,error:{code:message.match(/^[A-Z][A-Z_]+(?=:|$)/)?.[0] ?? "CHAT_GOAL_FAILED",message}};
};
const terminal = (b: ChatGoalBinding) => ["completed","stopped"].includes(b.state);
const canonical = (path: string) => process.platform==="win32" ? resolve(path).toLowerCase() : resolve(path);

/** Deterministic MCP orchestration only. There is no model, background turn loop or scheduler. */
export class ChatGoalController {
  readonly store: ChatGoalStore;
  private closing = false;
  private readonly operations = new Set<Promise<ChatReply>>();
  private readonly questionRequests = new Set<string>();
  constructor(private readonly options: {stateDir:string;config:ChatGoalConfig;now?:()=>number}) {
    this.store = new ChatGoalStore(options.stateDir);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  async create(ctx: ChatGoalContext, requestKey: string, input: ChatGoalSpec): Promise<ChatReply> {
    chatGoalPhase("controller_entered");
    try {
      const spec = chatGoalSpecSchema.parse(input);
      await ctx.authorize();
      chatGoalPhase("authorization_passed");
      const root = await realpath(ctx.workspaceRoot), dataRoot = await realpath(this.options.config.dataRoot);
      if (![this.options.config.dataRoot,this.options.config.shrimpEntryPoint].every(isAbsolute)) throw new Error("CONFIGURATION_REQUIRED: absolute Shrimp installation and data paths required.");
      if (canonical(root)!==canonical(ctx.workspaceRoot) || canonical(dataRoot)!==canonical(this.options.config.dataRoot)) throw new Error("ALIAS_NOT_ALLOWED: use canonical project and data roots.");
      const inside = (a:string,b:string) => {const rel=relative(a,b);return !rel || (!rel.startsWith("..")&&!isAbsolute(rel));};
      if (inside(root,dataRoot)||inside(dataRoot,root)) throw new Error("DATA_ROOT_CONFLICT: project and Shrimp data must be separate trees.");
      const goalRef = `chatgoal_${sha256(`${ctx.ownerRef}\0${requestKey}`).slice(0,32)}`;
      const existing = this.store.list(ctx.ownerRef,canonical(root)).some(b=>b.goalRef===goalRef);
      if (!existing && (await readdir(root)).some(name=>name===".git" || !/\.md$/i.test(name))) throw new Error("FRESH_PROJECT_REQUIRED: preview accepts a new project containing only optional input Markdown documents.");
      this.store.prepare({goalRef,ownerRef:ctx.ownerRef,workspaceRoot:canonical(root),dataDir:join(dataRoot,goalRef),
        creationKey:requestKey,spec,revision:1,state:"paused",proofs:{}});
      return this.mutate(ctx,{goalRef,requestKey,expectedRevision:1},{action:"create",spec},async(b,io)=>{
        await mkdir(b.dataDir); // Exclusive fresh DATA_DIR. Never reuse native Goal or other Shrimp state.
        projectGit(b.workspaceRoot,"init");
        b.projectGitConfigHash=sha256(await readFile(join(b.workspaceRoot,".git","config")));
        const client = await io.shrimp(true);
        await client.call("list_tasks",{status:"all"});
        await io.write("split_tasks",{updateMode:"append",tasksRaw:JSON.stringify(spec.tasks.map(task=>({
          name:task.name,description:task.description,implementationGuide:task.implementationGuide,dependencies:task.dependencies,
          verificationCriteria:JSON.stringify(task.checks),
        }))),globalAnalysisResult:JSON.stringify({objective:spec.objective,successCriteria:spec.successCriteria,constraints:spec.constraints})});
        b.state="ready";
      });
    } catch (error) { return chatGoalFailure(error); }
  }
  async status(ctx: ChatGoalContext, goalRef?: string): Promise<ChatReply> {
    chatGoalPhase("controller_entered");
    try {
      await ctx.authorize();
      chatGoalPhase("authorization_passed");
      if (!goalRef) return {ok:true,data:{...CHAT_GOAL_BOUNDARIES,goals:this.store.list(ctx.ownerRef,canonical(ctx.workspaceRoot)).map(b=>({goalRef:b.goalRef,objective:b.spec.objective,revision:b.revision,state:b.state}))}};
      const b = this.owned(ctx,goalRef);
      return {ok:true,data:await this.view(b)};
    } catch (error) { return chatGoalFailure(error); }
  }
  next(ctx: ChatGoalContext, input: Mutation & {leaseToken?:string}): Promise<ChatReply> {
    return this.mutate(ctx,input,{action:"next",leaseToken:input.leaseToken},async(b,io)=>{
      this.ready(b);
      delete b.handoff;
      const tasks = (await this.tasks(b)).tasks;
      const next = nextShrimpTask(tasks);
      if (!next) throw new Error("FINAL_ACCEPTANCE_REQUIRED: no task may be replayed; inspect Goal acceptance.");
      if (b.lease) {
        if (input.leaseToken!==b.lease.token || next.id!==b.lease.taskId) throw new Error("RECONCILIATION_REQUIRED: task already claimed; inspect effects and recover the existing lease, never reclaim automatically.");
        b.lease.expiresAt=this.now()+10*60_000;
      } else {
        if (next.status!=="pending") throw new Error("RECONCILIATION_REQUIRED: running task has no owned lease.");
        await io.write("execute_task",{taskId:next.id});
        b.lease={taskId:next.id,token:randomUUID(),expiresAt:this.now()+10*60_000};
      }
    },true);
  }
  complete(ctx: ChatGoalContext, input: Mutation & {taskId:string;leaseToken:string;assessment:string}): Promise<ChatReply> {
    return this.mutate(ctx,input,{action:"complete",taskId:input.taskId,leaseToken:input.leaseToken,assessment:input.assessment},async(b,io)=>{
      this.ready(b);
      delete b.handoff;
      if (!b.lease || b.lease.taskId!==input.taskId || b.lease.token!==input.leaseToken || b.lease.expiresAt<=this.now()) throw new Error("LEASE_REQUIRED: read status and renew the existing lease after checking command outcomes.");
      const tasks = (await this.tasks(b)).tasks;
      const task = nextShrimpTask(tasks);
      if (!task || task.id!==input.taskId || task.status!=="in_progress") throw new Error("DEPENDENCY_INVALID: only the claimed next task may complete.");
      const artifacts = await this.verifyTask(b,task);
      // Complete the last task only after every frozen task check passes again.
      if (tasks.filter(t=>t.status!=="completed").length===1) {
        for (const candidate of tasks) await this.verifyTask(b,candidate);
      }
      await ctx.authorize();
      if (sha256(await readFile(join(b.workspaceRoot,".git","config")))!==b.projectGitConfigHash) throw new Error("RECONCILIATION_REQUIRED: project Git configuration changed after enrollment.");
      if (projectGit(b.workspaceRoot,"diff","--cached","--name-only")) throw new Error("GIT_INDEX_NOT_EMPTY: do not include unrelated staged changes in a Goal checkpoint.");
      io.markEffect();
      projectGit(b.workspaceRoot,"add","--",...artifacts.map(a=>a.path));
      if (projectGit(b.workspaceRoot,"diff","--cached","--name-only")) projectGit(b.workspaceRoot,"commit","-m",`chat goal: verified task ${task.id}`);
      const projectCommit=projectGit(b.workspaceRoot,"rev-parse","HEAD");
      for (const artifact of artifacts) {
        if (projectGit(b.workspaceRoot,"rev-parse",`HEAD:${artifact.path}`)!==projectGit(b.workspaceRoot,"hash-object","--no-filters","--",artifact.path)) throw new Error("VERIFICATION_FAILED: Git checkpoint differs from the verified file bytes.");
      }
      b.proofs[task.id]={artifacts,hostAssessment:input.assessment,recordedAt:new Date(this.now()).toISOString(),projectCommit};
      await io.write("verify_task",{taskId:task.id,score:100,summary:`Host assessment and deterministic file checks (not an independent model grade): ${input.assessment}`});
      delete b.lease;
      const after = (await this.tasks(b)).tasks;
      if (after.every(t=>t.status==="completed")) b.state="completed";
      // Return the next task context in this same reply; the host decides to claim it.
    });
  }
  handoff(ctx: ChatGoalContext, input: Mutation): Promise<ChatReply> {
    return this.mutate(ctx,input,{action:"handoff"},async b=>{
      this.ready(b);
      const tasks=(await this.tasks(b)).tasks;
      const next=nextShrimpTask(tasks);
      if (!b.lease && !next) throw new Error("FINAL_ACCEPTANCE_REQUIRED: no unfinished task exists to hand off.");
      b.handoff={
        id:randomUUID(),
        taskId:b.lease?.taskId ?? next?.id ?? null,
        createdAt:this.now(),
        expiresAt:this.now()+30*60_000,
        state:"pending",
      };
    });
  }
  resume(ctx: ChatGoalContext, input: Mutation & {handoffId:string}): Promise<ChatReply> {
    return this.mutate(ctx,input,{action:"resume_handoff",handoffId:input.handoffId},async b=>{
      this.ready(b);
      const handoff=b.handoff;
      if (!handoff || handoff.id!==input.handoffId || handoff.state!=="pending" || handoff.expiresAt<=this.now()) {
        throw new Error("STALE_HANDOFF: read current Goal status; only a live handoff from the unfinished Goal may resume.");
      }
      const tasks=(await this.tasks(b)).tasks;
      const next=nextShrimpTask(tasks);
      if (b.lease) {
        if (handoff.taskId!==b.lease.taskId || !next || next.id!==b.lease.taskId || next.status!=="in_progress") {
          throw new Error("RECONCILIATION_REQUIRED: the persisted task no longer matches the handed-off lease.");
        }
        b.lease.expiresAt=this.now()+10*60_000;
      } else if (!next || handoff.taskId!==next.id || next.status!=="pending") {
        throw new Error("RECONCILIATION_REQUIRED: the next task changed after handoff; inspect current Goal state.");
      }
      handoff.state="consumed";
      handoff.consumedAt=this.now();
    },true);
  }
  control(ctx: ChatGoalContext, input: Mutation & {action:"pause"|"resume"|"stop"}): Promise<ChatReply> {
    return this.mutate(ctx,input,{action:input.action},async b=>{
      if (terminal(b)) throw new Error("GOAL_TERMINAL: completed/stopped Goals cannot resume or repeat tasks.");
      if (b.state==="needs_reconciliation") throw new Error("RECONCILIATION_REQUIRED: inspect the recorded failure before control changes.");
      if (input.action==="resume") {
        if (b.state!=="paused" || (b.decision && b.decision.state!=="accepted")) throw new Error("DECISION_REQUIRED: an unanswered decision cannot be bypassed by resume. Ask the user again with a new question key.");
        b.state="ready";
      } else {
        b.state=input.action==="pause"?"paused":"stopped";
        if (b.decision?.state==="pending") b.decision.state="cancelled";
      }
      delete b.handoff;
    });
  }
  ask(ctx: ChatGoalContext, input: Mutation & ChatQuestion): Promise<ChatReply> {
    return this.mutate(ctx,input,{action:"ask",question:input.question,choices:input.choices},async b=>{
      if (b.state!=="ready" && b.state!=="paused") throw new Error("GOAL_NOT_READY: cannot replace an active decision or reopen a terminal Goal.");
      delete b.handoff;
      b.decision={id:randomUUID(),question:input.question,choices:input.choices,state:"pending",expiresAt:this.now()+10*60_000};
      b.state="waiting_for_user";
    });
  }
  /** Called ONLY by elicitation or authenticated app-only card handlers. Never
   * expose acceptance as a model-callable tool or infer it from a timeout. */
  resolveDecision(ctx: ChatGoalContext, goalRef: string, decisionId: string, result: {action:"accept"|"decline"|"cancel";answer?:string}): Promise<ChatReply> {
    try {
      const current=this.owned(ctx,goalRef);
      return this.mutate(ctx,{goalRef,requestKey:`decision:${decisionId}`,expectedRevision:current.revision},{action:"decision",decisionId,result},async b=>{
        const d=b.decision;
        if (b.state!=="waiting_for_user" || d?.id!==decisionId || d.state!=="pending" || d.expiresAt<=this.now()) throw new Error("STALE_DECISION: expired, superseded or already handled request.");
        if (result.action==="accept") {
          if (!result.answer || !d.choices.includes(result.answer)) throw new Error("INVALID_DECISION: choose one displayed option.");
          d.answer=result.answer; d.state="accepted"; b.state="ready";
        } else { d.state=result.action==="decline"?"declined":"cancelled"; b.state="paused"; }
        delete b.handoff;
      });
    } catch (error) { return Promise.resolve(chatGoalFailure(error)); }
  }
  beginQuestionPresentation(goalRef:string,decisionId:string):(()=>void)|undefined {
    const key=`${goalRef}:${decisionId}`;
    if (this.questionRequests.has(key)) return undefined;
    this.questionRequests.add(key);
    return ()=>{this.questionRequests.delete(key);};
  }
  private owned(ctx: ChatGoalContext, goalRef:string): ChatGoalBinding {
    const b=this.store.get(ctx.ownerRef,goalRef);
    if (b.workspaceRoot!==canonical(ctx.workspaceRoot)) throw new Error("WORKSPACE_MISMATCH: open this Goal's exact authorized project.");
    return b;
  }
  private ready(b:ChatGoalBinding):void {
    if (terminal(b)) throw new Error("GOAL_TERMINAL: work is finished; do not repeat tasks.");
    if (b.state!=="ready") throw new Error("GOAL_NOT_READY: paused, awaiting a user, or requires reconciliation.");
  }
  private async tasks(b:ChatGoalBinding) {
    const dataRoot=await realpath(this.options.config.dataRoot),dataDir=await realpath(b.dataDir);
    const rel=relative(dataRoot,dataDir);
    if (canonical(dataRoot)!==canonical(this.options.config.dataRoot) || canonical(dataDir)!==canonical(b.dataDir)
      || !rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("DATA_ROOT_CONFLICT: Shrimp state path changed or escaped its configured root.");
    const state=await readGoalTasks(b.dataDir);
    if (b.taskHash && b.taskHash!==state.hash) throw new Error("RECONCILIATION_REQUIRED: Shrimp state changed outside the controller.");
    if (state.tasks.length!==b.spec.tasks.length || state.tasks.some(t=>!b.spec.tasks.some(s=>s.name===t.name))) throw new Error("RECONCILIATION_REQUIRED: task manifest differs from the frozen contract.");
    for (const task of state.tasks) {
      const spec=b.spec.tasks.find(s=>s.name===task.name)!;
      const deps=task.dependencies.map(d=>state.tasks.find(t=>t.id===d.taskId)!.name).sort();
      if (JSON.stringify(deps)!==JSON.stringify([...spec.dependencies].sort())) throw new Error("DEPENDENCY_INVALID: persisted dependencies differ from the contract.");
    }
    return state;
  }
  private async verifyTask(b:ChatGoalBinding,task:ShrimpTask):Promise<ArtifactEvidence[]> {
    const checks=b.spec.tasks.find(t=>t.name===task.name)!.checks;
    const artifacts=await scopedArtifacts(b.workspaceRoot,checks.map(c=>c.path));
    for (const check of checks) {
      const bytes=await readFile(join(b.workspaceRoot,check.path));
      const hash=sha256(bytes);
      if (!artifacts.some(a=>a.sha256===hash) || (check.sha256 && check.sha256!==hash)
        || (check.contains && !bytes.toString("utf8").includes(check.contains))) throw new Error(`VERIFICATION_FAILED: artifact does not meet the frozen check: ${check.path}`);
    }
    return artifacts;
  }
  private async view(b:ChatGoalBinding,includeLease=false,ownOperation=false):Promise<Record<string,unknown>> {
    let state: Awaited<ReturnType<ChatGoalController["tasks"]>>|undefined, error=b.error;
    try { state=await this.tasks(b); } catch(e) { error=e instanceof Error?e.message:String(e); }
    let next:ShrimpTask|null=null;
    if (state) try { next=nextShrimpTask(state.tasks); } catch(e) { error=String(e); }
    const inflight=!ownOperation&&this.store.inflight(b.goalRef);
    const handoffState=b.handoff?.state==="pending"&&b.handoff.expiresAt<=this.now()?"expired":b.handoff?.state;
    const handoffPending=handoffState==="pending";
    const nextAction=error||inflight?"reconcile":terminal(b)?"stop":b.state==="waiting_for_user"?"await_user":b.state==="paused"?"paused":handoffPending?"resume_handoff":b.lease?(b.lease.expiresAt<=this.now()?"inspect_then_renew_lease":includeLease?"execute_claimed_task":"inspect_existing_claim"):next?"claim_next_task":"final_acceptance_required";
    return {...CHAT_GOAL_BOUNDARIES,goalRef:b.goalRef,revision:b.revision,state:b.state,objective:b.spec.objective,
      successCriteria:b.spec.successCriteria,constraints:b.spec.constraints,nextAction,error:error??null,
      tasks:state?.tasks.map(t=>({id:t.id,name:t.name,status:t.status,dependencies:t.dependencies})),
      nextTask:next?{...next,contract:b.spec.tasks.find(t=>t.name===next!.name)}:null,
      lease:b.lease?{taskId:b.lease.taskId,expiresAt:b.lease.expiresAt,...(includeLease?{token:b.lease.token}:{})}:null,
      handoff:b.handoff?{id:b.handoff.id,taskId:b.handoff.taskId,createdAt:b.handoff.createdAt,expiresAt:b.handoff.expiresAt,state:handoffState,...(b.handoff.consumedAt?{consumedAt:b.handoff.consumedAt}:{})}:null,
      continuation:{handoffTool:"chat_goal_handoff",resumeTool:"chat_goal_resume",autoContinueWithinActiveTurn:true,requiresExplicitUserContinuationAfterTurnEnd:true},
      decision:b.decision??null,proofs:b.proofs,taskHash:state?.hash??null,taskCommit:b.taskCommit??null,
      instruction:nextAction==="stop"?"The finite Goal is terminal. Stop calling execution tools.":nextAction==="resume_handoff"?"This Goal was handed off. Only after an explicit new user continuation may the current Chat model call chat_goal_resume with this handoff ID; no background or Codex model is started.":"While this host request remains active, continue through claim, execution and completion without pausing between dependency-ready tasks. Before intentionally ending with unfinished work, call chat_goal_handoff once. Never infer host liveness or free quota from persisted state.",
    };
  }
  private mutate(ctx:ChatGoalContext,input:Mutation,details:unknown,run:(b:ChatGoalBinding,io:{shrimp:(fresh?:boolean)=>Promise<GoalShrimpClient>;write:(name:string,args:Record<string,unknown>)=>Promise<void>;markEffect:()=>void})=>Promise<void>,includeLease=false):Promise<ChatReply> {
    chatGoalPhase("controller_entered");
    if (this.closing) return Promise.resolve(chatGoalFailure(new Error("CHAT_GOAL_UNAVAILABLE: server shutting down.")));
    const operation=(async():Promise<ChatReply>=>{
      let binding:ChatGoalBinding|undefined,unchanged:ChatGoalBinding|undefined,client:GoalShrimpClient|undefined,externalWrite=false;
      try {
        await ctx.authorize(); this.owned(ctx,input.goalRef);
        chatGoalPhase("authorization_passed");
        const started=this.store.begin(ctx.ownerRef,input.goalRef,input.requestKey,sha256(JSON.stringify([input.goalRef,input.expectedRevision,details])),input.expectedRevision);
        if ("reply" in started) {chatGoalPhase("journal_replayed",{replayed:true});return started.reply;}
        binding=started.binding;
        chatGoalPhase("journal_started",{revision:binding.revision,state:binding.state});
        unchanged=structuredClone(binding);
        const b=binding;
        const shrimp=async(fresh=false)=>{
          if (client) return client;
          if (!fresh) await this.tasks(b);
          client=new GoalShrimpClient({command:process.execPath,entryPoint:this.options.config.shrimpEntryPoint,
            workspaceRoot:b.workspaceRoot,dataDir:b.dataDir,allowedDataRoot:this.options.config.dataRoot,initializeEmpty:fresh,
            authorizeWrite:()=>ctx.authorize(),verifyEvidence:async task=>{await this.verifyTask(b,task);},
            env:{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",
              GIT_CONFIG_COUNT:"2",GIT_CONFIG_KEY_0:"core.autocrlf",GIT_CONFIG_VALUE_0:"false",GIT_CONFIG_KEY_1:"core.hooksPath",GIT_CONFIG_VALUE_1:"/dev/null"},
          });
          await client.connect();return client;
        };
        await run(b,{shrimp,markEffect:()=>{externalWrite=true;},write:async(name,args)=>{
          const s=await shrimp();externalWrite=true;
          await s.call(name,args);
          const after=await s.snapshot();b.taskHash=after.hash;b.taskCommit=after.commit;
        }});
        await ctx.authorize();
        if (client) {await client.close();client=undefined;}
        b.revision++;
        const reply:ChatReply={ok:true,data:await this.view(b,includeLease,true)};
        this.store.finish(b,input.requestKey,reply);
        chatGoalPhase("journal_committed",{revision:b.revision,state:b.state,outcome:"success"});
        return reply;
      } catch(error) {
        const reply=chatGoalFailure(error);
        if (binding) {
          // Once an upstream effect may have occurred, retain uncertainty. Never automatically replay.
          if (externalWrite || (details as {action?:string}).action==="create") {binding.state="needs_reconciliation";binding.error=reply.error!.message;binding.revision++;}
          else if(unchanged)binding=unchanged; // Authorization/validation failure must not commit an in-memory decision or control change.
          try { this.store.finish(binding,input.requestKey,reply);chatGoalPhase("journal_committed",{revision:binding.revision,state:binding.state,outcome:"failure"}); }
          catch {chatGoalPhase("journal_retained"); /* Pending journal is intentionally retained. */ }
        }
        return reply;
      } finally { if(client) await client.close().catch(()=>{}); }
    })();
    this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation));return operation;
  }
  async close():Promise<void> {this.closing=true;await Promise.allSettled(this.operations);this.store.close();}
}

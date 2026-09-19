import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { openDatabase, type DatabaseHandle } from './db/client.js';

export type GoalControlState = 'running' | 'pause_requested' | 'paused' | 'stop_requested' | 'stopped' | 'completed';
export interface GoalBinding {
  goalRef: string;
  ownerRef: string;
  workspaceRoot: string;
  dataDir: string;
  creationRequestKey: string;
  providerSessionId: string | null;
  creationPhase: 'prepared' | 'creating' | 'bound' | 'needs_reconciliation';
  controlState: GoalControlState;
  revision: number;
  ownerEpoch: number;
  checkpointRef: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Integration metadata in the existing DevSpace DB, never Goal/Task state. */
export class GoalBindingStore {
  private readonly database: DatabaseHandle;
  constructor(stateDir: string) { this.database = openDatabase(stateDir); }
  prepare(input: { ownerRef: string; workspaceRoot: string; dataDir: string; requestKey: string; spec?: unknown }): GoalBinding {
    for (const s of [input.ownerRef,input.requestKey]) if (!s.trim() || s.length>256) throw new Error('Invalid principal or request key');
    if(!isAbsolute(input.workspaceRoot)||!isAbsolute(input.dataDir)) throw new Error('Canonical absolute paths required');
    const workspaceRoot = canonical(input.workspaceRoot), dataDir=canonical(input.dataDir);
    const transaction=this.database.sqlite.transaction(()=>{
      const existing=this.database.sqlite.prepare('select * from managed_goal_bindings where owner_ref=? and creation_request_key=?').get(input.ownerRef,input.requestKey);
      if(existing){
        const record=decode(existing);
        if(record.workspaceRoot!==workspaceRoot||record.dataDir!==dataDir)throw new Error('REQUEST_KEY_CONFLICT');
        if (input.spec !== undefined && JSON.stringify(this.metadata(input.ownerRef,record.goalRef).spec) !== JSON.stringify(input.spec)) throw new Error('REQUEST_KEY_CONFLICT');
        return record;
      }
      if(this.database.sqlite.prepare("select goal_ref from managed_goal_bindings where workspace_root=? and control_state not in ('stopped','completed')").get(workspaceRoot))throw new Error('GOAL_BUSY');
      if(this.database.sqlite.prepare("select goal_ref from chat_goal_bindings where workspace_root=? and json_extract(metadata_json,'$.state') not in ('stopped','completed')").get(workspaceRoot))throw new Error('GOAL_BUSY: a Chat-driven Goal owns this project');
      const now=new Date().toISOString(),id=`goal_${randomUUID()}`;
      this.database.sqlite.prepare(`insert into managed_goal_bindings(goal_ref,owner_ref,workspace_root,data_dir,creation_request_key,creation_phase,control_state,created_at,updated_at) values (?,?,?,?,?,'prepared','paused',?,?)`).run(id,input.ownerRef,workspaceRoot,dataDir,input.requestKey,now,now);
      if(input.spec !== undefined) this.database.sqlite.prepare('update managed_goal_bindings set spec_json=? where goal_ref=?').run(JSON.stringify(input.spec),id);
      return this.get(input.ownerRef,id);
    });
    return transaction.immediate();
  }
  get(ownerRef: string, goalRef: string): GoalBinding {
    const row=this.database.sqlite.prepare('select * from managed_goal_bindings where owner_ref=? and goal_ref=?').get(ownerRef,goalRef);
    if(!row)throw new Error('GOAL_NOT_FOUND');
    return decode(row);
  }
  list(ownerRef: string, workspaceRoot: string): GoalBinding[] {
    return this.database.sqlite.prepare('select * from managed_goal_bindings where owner_ref=? and workspace_root=? order by created_at desc').all(ownerRef,canonical(workspaceRoot)).map(decode);
  }
  all(ownerRef?: string): GoalBinding[] {
    return (ownerRef
      ? this.database.sqlite.prepare('select * from managed_goal_bindings where owner_ref=? order by created_at desc').all(ownerRef)
      : this.database.sqlite.prepare('select * from managed_goal_bindings order by created_at desc').all()).map(decode);
  }
  metadata(ownerRef:string,goalRef:string): {spec:unknown;observation:Record<string,unknown>|null} {
    this.get(ownerRef,goalRef);
    const row=this.database.sqlite.prepare('select spec_json,observation_json from managed_goal_bindings where goal_ref=?').get(goalRef) as {spec_json:string|null;observation_json:string|null};
    return {spec:row.spec_json?JSON.parse(row.spec_json):null,observation:row.observation_json?JSON.parse(row.observation_json):null};
  }
  observe(binding:GoalBinding,observation:Record<string,unknown>):void {
    const changed=this.database.sqlite.prepare('update managed_goal_bindings set observation_json=? where goal_ref=? and owner_ref=? and owner_epoch=?').run(JSON.stringify(observation),binding.goalRef,binding.ownerRef,binding.ownerEpoch);
    if(!changed.changes)throw new Error('STALE_OWNER_OR_REVISION');
  }
  phase(binding:GoalBinding,phase:GoalBinding['creationPhase']):GoalBinding {
    const changed=this.database.sqlite.prepare('update managed_goal_bindings set creation_phase=?,revision=revision+1,updated_at=? where goal_ref=? and owner_ref=? and revision=? and owner_epoch=?').run(phase,new Date().toISOString(),binding.goalRef,binding.ownerRef,binding.revision,binding.ownerEpoch);
    if(!changed.changes)throw new Error('STALE_OWNER_OR_REVISION');
    return this.get(binding.ownerRef,binding.goalRef);
  }
  bind(ownerRef: string,goalRef: string,expectedRevision: number,threadId: string): GoalBinding {
    if(!threadId.trim())throw new Error('Native thread id required');
    const changed=this.database.sqlite.prepare(`update managed_goal_bindings set provider_session_id=?,creation_phase='bound',revision=revision+1,updated_at=? where owner_ref=? and goal_ref=? and revision=? and provider_session_id is null`).run(threadId,new Date().toISOString(),ownerRef,goalRef,expectedRevision);
    if(!changed.changes)throw new Error('RECONCILIATION_REQUIRED: binding changed');
    return this.get(ownerRef,goalRef);
  }
  control(input:{ownerRef:string;goalRef:string;expectedRevision:number;expectedEpoch:number;requestKey:string;state:GoalControlState}):GoalBinding {
    if(!input.requestKey.trim()||input.requestKey.length>256)throw new Error('Invalid request key');
    const fingerprint=createHash('sha256').update(JSON.stringify([input.goalRef,input.expectedRevision,input.expectedEpoch,input.state])).digest('hex');
    return this.database.sqlite.transaction(()=>{
      const op=this.database.sqlite.prepare('select request_fingerprint,response_json from managed_goal_operations where owner_ref=? and request_key=?').get(input.ownerRef,input.requestKey) as {request_fingerprint:string;response_json:string}|undefined;
      if(op){if(op.request_fingerprint!==fingerprint)throw new Error('REQUEST_KEY_CONFLICT');return JSON.parse(op.response_json) as GoalBinding;}
      const before=this.get(input.ownerRef,input.goalRef);
      if(before.revision!==input.expectedRevision||before.ownerEpoch!==input.expectedEpoch)throw new Error('STALE_OWNER_OR_REVISION');
      if((before.controlState==='stopped'||before.controlState==='completed')&&input.state!==before.controlState&&input.state!=='stopped')throw new Error('Stopped or completed Goal requires a new explicit run');
      if(input.state==='running'&&before.creationPhase!=='bound')throw new Error('RECONCILIATION_REQUIRED: native thread unbound');
      this.database.sqlite.prepare('update managed_goal_bindings set control_state=?,revision=revision+1,updated_at=? where goal_ref=?').run(input.state,new Date().toISOString(),input.goalRef);
      const after=this.get(input.ownerRef,input.goalRef);
      this.database.sqlite.prepare('insert into managed_goal_operations values (?,?,?,?,?,?)').run(input.ownerRef,input.requestKey,input.goalRef,fingerprint,JSON.stringify(after),new Date().toISOString());
      return after;
    }).immediate();
  }
  /** Only after the prior process is confirmed dead by the existing daemon owner. */
  fenceForRecovery(ownerRef:string,goalRef:string,expectedRevision:number):GoalBinding {
    const result=this.database.sqlite.prepare(`update managed_goal_bindings set owner_epoch=owner_epoch+1,revision=revision+1,control_state='paused',creation_phase=case when provider_session_id is null then 'needs_reconciliation' else creation_phase end,updated_at=? where owner_ref=? and goal_ref=? and revision=? and control_state not in ('stopped','completed')`).run(new Date().toISOString(),ownerRef,goalRef,expectedRevision);
    if(!result.changes)throw new Error('STALE_OWNER_OR_REVISION');
    return this.get(ownerRef,goalRef);
  }
  close():void {this.database.close();}
}
function canonical(path:string):string {const p=resolve(path);return process.platform==='win32'?p.toLowerCase():p;}
function decode(value:unknown):GoalBinding {
 const r=value as Record<string,any>;
 return {goalRef:r.goal_ref,ownerRef:r.owner_ref,workspaceRoot:r.workspace_root,dataDir:r.data_dir,creationRequestKey:r.creation_request_key,providerSessionId:r.provider_session_id,creationPhase:r.creation_phase,controlState:r.control_state,revision:r.revision,ownerEpoch:r.owner_epoch,checkpointRef:r.checkpoint_ref,createdAt:r.created_at,updatedAt:r.updated_at};
}

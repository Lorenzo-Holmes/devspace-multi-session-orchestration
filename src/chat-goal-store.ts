import { openDatabase } from "./db/client.js";
import type { ChatGoalSpec, ChatQuestion } from "./chat-goal-contracts.js";
import type { ArtifactEvidence } from "./goal-evidence.js";

export interface ChatGoalBinding {
  goalRef: string; ownerRef: string; workspaceRoot: string; dataDir: string;
  creationKey: string; spec: ChatGoalSpec; revision: number;
  state: "ready" | "paused" | "waiting_for_user" | "completed" | "stopped" | "needs_reconciliation";
  lease?: {taskId: string; token: string; expiresAt: number};
  handoff?: {id:string;taskId:string|null;createdAt:number;expiresAt:number;state:"pending"|"consumed";consumedAt?:number};
  decision?: ChatQuestion & {id: string; expiresAt: number; state: "pending" | "accepted" | "declined" | "cancelled"; answer?: string};
  proofs: Record<string, {artifacts: ArtifactEvidence[]; hostAssessment: string; recordedAt: string;projectCommit?:string}>;
  projectGitConfigHash?: string;
  taskHash?: string; taskCommit?: string | null;
  error?: string;
}
export interface ChatReply { ok: boolean; data?: Record<string, unknown>; error?: {code: string; message: string}; replayed?: boolean }

/** Contract, leases, evidence and request journal in DevSpace's existing SQLite DB.
 * Task status/dependencies live ONLY in the original Shrimp DATA_DIR. */
export class ChatGoalStore {
  readonly database;
  constructor(stateDir: string) { this.database = openDatabase(stateDir); }
  get(owner: string, id: string): ChatGoalBinding {
    const row = this.database.sqlite.prepare("select metadata_json from chat_goal_bindings where owner_ref=? and goal_ref=?").get(owner,id) as {metadata_json:string}|undefined;
    if (!row) throw new Error("CHAT_GOAL_NOT_FOUND: no owned Chat Goal with this ID.");
    return JSON.parse(row.metadata_json);
  }
  list(owner: string, root: string): ChatGoalBinding[] {
    return (this.database.sqlite.prepare("select metadata_json from chat_goal_bindings where owner_ref=? and workspace_root=? order by rowid desc").all(owner,root) as {metadata_json:string}[]).map(row=>JSON.parse(row.metadata_json));
  }
  prepare(binding: ChatGoalBinding): ChatGoalBinding {
    return this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare("select metadata_json from chat_goal_bindings where owner_ref=? and creation_key=?").get(binding.ownerRef,binding.creationKey) as {metadata_json:string}|undefined;
      if (row) {
        const old = JSON.parse(row.metadata_json) as ChatGoalBinding;
        if (old.workspaceRoot!==binding.workspaceRoot || JSON.stringify(old.spec)!==JSON.stringify(binding.spec)) throw new Error("REQUEST_KEY_CONFLICT: creation key already binds a different contract.");
        return old;
      }
      if (this.database.sqlite.prepare("select goal_ref from managed_goal_bindings where workspace_root=? and control_state not in ('completed','stopped')").get(binding.workspaceRoot)) throw new Error("GOAL_BUSY: an existing native Goal owns this project.");
      if (this.database.sqlite.prepare("select goal_ref from chat_goal_bindings where workspace_root=? and json_extract(metadata_json,'$.state') not in ('completed','stopped')").get(binding.workspaceRoot)) throw new Error("GOAL_BUSY: another Chat Goal owns this project.");
      this.database.sqlite.prepare("insert into chat_goal_bindings(goal_ref,owner_ref,workspace_root,creation_key,metadata_json) values (?,?,?,?,?)").run(binding.goalRef,binding.ownerRef,binding.workspaceRoot,binding.creationKey,JSON.stringify(binding));
      return binding;
    }).immediate();
  }
  begin(owner: string, id: string, key: string, fingerprint: string, revision: number): {binding:ChatGoalBinding} | {reply:ChatReply} {
    return this.database.sqlite.transaction(() => {
      const old = this.database.sqlite.prepare("select fingerprint,response_json from chat_goal_requests where owner_ref=? and request_key=?").get(owner,key) as {fingerprint:string;response_json:string|null}|undefined;
      if (old) {
        if (old.fingerprint!==fingerprint) throw new Error("REQUEST_KEY_CONFLICT: retry the identical operation.");
        if (!old.response_json) throw new Error("RECONCILIATION_REQUIRED: operation in flight or interrupted; do not replay its effects.");
        return {reply:{...JSON.parse(old.response_json),replayed:true}};
      }
      const binding = this.get(owner,id);
      if (binding.revision!==revision) throw new Error("STALE_REVISION: read current Chat Goal status.");
      const locked = this.database.sqlite.prepare("update chat_goal_bindings set inflight_key=? where goal_ref=? and inflight_key is null").run(key,id);
      if (!locked.changes) throw new Error("RECONCILIATION_REQUIRED: another operation owns this Goal.");
      this.database.sqlite.prepare("insert into chat_goal_requests(owner_ref,request_key,goal_ref,fingerprint) values (?,?,?,?)").run(owner,key,id,fingerprint);
      return {binding};
    }).immediate();
  }
  finish(binding: ChatGoalBinding, key: string, reply: ChatReply): void {
    this.database.sqlite.transaction(() => {
      const changed = this.database.sqlite.prepare("update chat_goal_bindings set metadata_json=?,inflight_key=null where goal_ref=? and owner_ref=? and inflight_key=?").run(JSON.stringify(binding),binding.goalRef,binding.ownerRef,key);
      if (!changed.changes) throw new Error("STALE_OWNER: request journal retained for reconciliation.");
      this.database.sqlite.prepare("update chat_goal_requests set response_json=? where owner_ref=? and request_key=?").run(JSON.stringify(reply),binding.ownerRef,key);
    }).immediate();
  }
  inflight(id: string): boolean {
    return Boolean((this.database.sqlite.prepare("select inflight_key from chat_goal_bindings where goal_ref=?").get(id) as {inflight_key:string|null}).inflight_key);
  }
  close(): void { this.database.close(); }
}

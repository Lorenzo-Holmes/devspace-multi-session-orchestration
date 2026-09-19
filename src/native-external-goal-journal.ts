import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { bindingSchema, goalRefSchema, requestKeySchema, type ExternalGoalBinding, type ExternalGoalRef } from "./native-external-goal-contracts.js";

export interface ExternalIntent {
  requestKey: string;
  fingerprint: string;
  method: string;
}

/** Transport intent/result log only. Immutable native identity pointers are not Goal state.
 * It never stores objectives, Goal/Task state, revisions, prompts, leases, or credentials.
 * The caller must supply an already-authorized state path, separate from the native Goal DB.
 */
export class ExternalGoalIntentJournal {
  private readonly db: Database.Database;
  private readonly scope: string;
  constructor(path: string, binding: ExternalGoalBinding) {
    if (!isAbsolute(path)) throw new Error("INVALID_JOURNAL_BINDING");
    this.scope = scopeFor(binding);
    this.db = new Database(path);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS external_goal_stores (
          scope TEXT PRIMARY KEY, store_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS external_goal_intents (
          scope TEXT NOT NULL, request_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL, method TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('pending','applied','rejected')),
          PRIMARY KEY(scope, request_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS external_goal_one_pending
          ON external_goal_intents(scope) WHERE outcome='pending';
        CREATE TABLE IF NOT EXISTS external_goal_creation_results (
          scope TEXT NOT NULL, request_key TEXT NOT NULL,
          thread_id TEXT NOT NULL, goal_id TEXT NOT NULL,
          PRIMARY KEY(scope, request_key), UNIQUE(scope, thread_id, goal_id)
        );
      `);
    } catch (error) { this.db.close(); throw error; }
  }

  assertBinding(binding: ExternalGoalBinding): void {
    if (scopeFor(binding) !== this.scope) throw new Error("JOURNAL_BINDING_MISMATCH");
  }

  bindStore(storeId: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT store_id FROM external_goal_stores WHERE scope=?")
        .get(this.scope) as { store_id: string } | undefined;
      if (row && row.store_id !== storeId) throw new Error("NATIVE_STORE_CHANGED");
      this.db.prepare("INSERT OR IGNORE INTO external_goal_stores VALUES (?,?)").run(this.scope, storeId);
    }).immediate();
  }

  pending(): ExternalIntent | undefined {
    return this.db.prepare(`SELECT request_key AS requestKey, fingerprint, method
      FROM external_goal_intents WHERE scope=? AND outcome='pending'`).get(this.scope) as ExternalIntent | undefined;
  }

  begin(intent: ExternalIntent): void {
    this.db.transaction(() => {
      if (this.pending()) throw new Error("RECONCILIATION_REQUIRED");
      const old = this.db.prepare("SELECT fingerprint FROM external_goal_intents WHERE scope=? AND request_key=?")
        .get(this.scope, intent.requestKey) as { fingerprint: string } | undefined;
      if (old) throw new Error(old.fingerprint === intent.fingerprint ? "OPERATION_ALREADY_RECORDED" : "REQUEST_KEY_CONFLICT");
      this.db.prepare("INSERT INTO external_goal_intents VALUES (?,?,?,?,'pending')")
        .run(this.scope, intent.requestKey, intent.fingerprint, intent.method);
    }).immediate();
  }

  settle(intent: ExternalIntent, outcome: "applied" | "rejected", createdRef?: ExternalGoalRef): void {
    const ref = createdRef === undefined ? undefined : goalRefSchema.parse(createdRef);
    if (ref && (outcome !== "applied" || !intent.method.endsWith("/create"))) throw new Error("INVALID_CREATE_RESULT");
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE external_goal_intents SET outcome=?
        WHERE scope=? AND request_key=? AND fingerprint=? AND method=? AND outcome='pending'`)
        .run(outcome, this.scope, intent.requestKey, intent.fingerprint, intent.method);
      if (result.changes !== 1) throw new Error("JOURNAL_COMPARE_AND_SWAP_FAILED");
      if (ref) this.db.prepare("INSERT INTO external_goal_creation_results VALUES (?,?,?,?)")
        .run(this.scope, intent.requestKey, ref.threadId, ref.goalId);
    }).immediate();
  }

  createdRef(requestKey: string): ExternalGoalRef | null {
    const key = requestKeySchema.parse(requestKey);
    const row = this.db.prepare(`SELECT thread_id AS threadId, goal_id AS goalId
      FROM external_goal_creation_results WHERE scope=? AND request_key=?`).get(this.scope, key);
    return row ? goalRefSchema.parse(row) : null;
  }

  close(): void { this.db.close(); }
}

function scopeFor(input: ExternalGoalBinding): string {
  const binding = bindingSchema.parse(input);
  return createHash("sha256").update(JSON.stringify([binding.principalRef, binding.workspaceRoot])).digest("hex");
}

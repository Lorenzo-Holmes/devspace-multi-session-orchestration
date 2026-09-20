import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type V2Table = "worktree_bindings" | "integration_records" | "watchdog_alerts" | "handoff_checkpoints" | "project_memory" | "automation_due_work";
const tables = new Set<string>(["worktree_bindings", "integration_records", "watchdog_alerts", "handoff_checkpoints", "project_memory", "automation_due_work"]);
function assertTable(table: V2Table): void { if (!tables.has(table)) throw new Error("Unknown orchestration table."); }
export interface DurableRecord {
  id: string;
  projectKey: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Tables are a closed internal union; all caller values use SQL parameters. */
export class OrchestrationV2Store {
  onChange?: (table: V2Table, project: string) => void;
  private readonly database: DatabaseHandle;
  private transactionDepth = 0;
  private notifications: Array<{ table: V2Table; project: string }> = [];
  constructor(stateDir: string) { this.database = openDatabase(stateDir); }
  get<T extends DurableRecord>(table: V2Table, projectKey: string, id: string): T | undefined {
    assertTable(table);
    const row = this.database.sqlite.prepare(`select data_json from ${table} where project_key = ? and id = ?`)
      .get(projectKey, id) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as T : undefined;
  }
  list<T extends DurableRecord>(table: V2Table, projectKey: string, limit = 200, after = ""): T[] {
    assertTable(table);
    const rows = this.database.sqlite.prepare(`select data_json from ${table} where project_key = ? and id > ? order by id limit ?`)
      .all(projectKey, after, Math.max(1, Math.min(limit, 500))) as { data_json: string }[];
    return rows.map(row => JSON.parse(row.data_json) as T);
  }
  insert<T extends DurableRecord>(table: V2Table, value: T): T {
    assertTable(table);
    this.database.sqlite.prepare(`insert into ${table} (id, project_key, revision, data_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.projectKey, value.revision, JSON.stringify(value), value.createdAt, value.updatedAt);
    this.notify(table, value.projectKey);
    return value;
  }
  update<T extends DurableRecord>(table: V2Table, value: T, expectedRevision: number): T {
    assertTable(table);
    const next = { ...value, revision: expectedRevision + 1 };
    const result = this.database.sqlite.prepare(`update ${table} set revision = ?, data_json = ?, updated_at = ? where project_key = ? and id = ? and revision = ?`)
      .run(next.revision, JSON.stringify(next), next.updatedAt, next.projectKey, next.id, expectedRevision);
    if (result.changes !== 1) throw new Error("Record revision conflict or record outside project scope.");
    this.notify(table, value.projectKey);
    return next;
  }
  all<T extends DurableRecord>(table: V2Table, projectKey: string): T[] {
    assertTable(table);
    const rows = this.database.sqlite.prepare(`select data_json from ${table} where project_key = ? order by id`)
      .all(projectKey) as { data_json: string }[];
    return rows.map(row => JSON.parse(row.data_json) as T);
  }
  listInState<T extends DurableRecord>(table: V2Table, projectKey: string, state: string, limit = 200, after = ""): T[] {
    assertTable(table);
    const rows = this.database.sqlite.prepare(`select data_json from ${table}
      where project_key = ? and id > ? and json_extract(data_json, '$.state') = ? order by id limit ?`)
      .all(projectKey, after, state, Math.max(1, Math.min(limit, 500))) as { data_json: string }[];
    return rows.map(row => JSON.parse(row.data_json) as T);
  }
  transaction<T>(operation: () => T): T {
    const offset = this.notifications.length;
    this.transactionDepth++;
    let value: T;
    try {
      value = this.database.sqlite.transaction(() => {
        const result = operation();
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("An orchestration transaction must not await external effects.");
        return result;
      }).immediate();
    } catch (error) {
      this.notifications.length = offset;
      this.transactionDepth--;
      throw error;
    }
    this.transactionDepth--;
    if (this.transactionDepth === 0) {
      const pending = this.notifications;
      this.notifications = [];
      for (const entry of pending) this.notify(entry.table, entry.project);
    }
    return value;
  }
  private notify(table: V2Table, project: string): void {
    if (this.transactionDepth > 0) { this.notifications.push({ table, project }); return; }
    try { this.onChange?.(table, project); } catch { /* Committed writes survive observer failures. */ }
  }
  close(): void { this.database.close(); }
}

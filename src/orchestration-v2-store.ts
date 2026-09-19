import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type V2Table = "worktree_bindings" | "integration_records" | "watchdog_alerts" | "handoff_checkpoints" | "project_memory" | "automation_due_work";
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
  constructor(stateDir: string) { this.database = openDatabase(stateDir); }
  get<T extends DurableRecord>(table: V2Table, projectKey: string, id: string): T | undefined {
    const row = this.database.sqlite.prepare(`select data_json from ${table} where project_key = ? and id = ?`)
      .get(projectKey, id) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as T : undefined;
  }
  list<T extends DurableRecord>(table: V2Table, projectKey: string, limit = 200, after = ""): T[] {
    const rows = this.database.sqlite.prepare(`select data_json from ${table} where project_key = ? and id > ? order by id limit ?`)
      .all(projectKey, after, Math.max(1, Math.min(limit, 500))) as { data_json: string }[];
    return rows.map(row => JSON.parse(row.data_json) as T);
  }
  insert<T extends DurableRecord>(table: V2Table, value: T): T {
    this.database.sqlite.prepare(`insert into ${table} (id, project_key, revision, data_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.projectKey, value.revision, JSON.stringify(value), value.createdAt, value.updatedAt);
    try { this.onChange?.(table, value.projectKey); } catch { /* Observer failure cannot fail the original write. */ }
    return value;
  }
  update<T extends DurableRecord>(table: V2Table, value: T, expectedRevision: number): T {
    const next = { ...value, revision: expectedRevision + 1 };
    const result = this.database.sqlite.prepare(`update ${table} set revision = ?, data_json = ?, updated_at = ? where project_key = ? and id = ? and revision = ?`)
      .run(next.revision, JSON.stringify(next), next.updatedAt, next.projectKey, next.id, expectedRevision);
    if (result.changes !== 1) throw new Error("Record revision conflict or record outside project scope.");
    try { this.onChange?.(table, value.projectKey); } catch { /* Observer failure cannot fail the original write. */ }
    return next;
  }
  transaction<T>(operation: () => T): T { return this.database.sqlite.transaction(operation).immediate(); }
  close(): void { this.database.close(); }
}

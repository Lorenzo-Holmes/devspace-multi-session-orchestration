import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import { OrchestrationStore } from "./orchestration-store.js";

test("version 18 session DB upgrades atomically, survives an injected migration crash, and restarts idempotently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-migration-19-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const first = new OrchestrationStore(dir);
  const original = first.createSession({ id: "legacy", projectKey: "p", workspaceRoot: dir, state: "running" });
  first.close();
  // Reconstruct the exact pre-19 session columns in an isolated fixture DB.
  const legacy = new Database(databasePath(dir));
  legacy.exec(`drop index orchestration_events_kind_idx;
    alter table orchestration_sessions drop column revision;
    alter table orchestration_sessions drop column incarnation;
    alter table orchestration_sessions drop column binding_generation;
    alter table orchestration_sessions drop column file_generation;
    delete from devspace_schema_migrations where version = 19;
    create trigger injected_migration_crash before insert on devspace_schema_migrations
      when new.version = 19 begin select raise(abort, 'injected migration crash'); end;`);
  legacy.close();
  assert.throws(() => openDatabase(dir), /injected migration crash/);
  const inspect = new Database(databasePath(dir));
  const columns = inspect.prepare("pragma table_info(orchestration_sessions)").all() as Array<{ name: string }>;
  assert.equal(columns.some(column => column.name === "revision"), false, "schema changes rolled back with the failed ledger insert");
  inspect.exec("drop trigger injected_migration_crash");
  inspect.close();
  const upgraded = new OrchestrationStore(dir);
  assert.equal(upgraded.getSession("legacy")?.projectKey, original.projectKey);
  assert.equal(upgraded.getSession("legacy")?.revision, 1);
  upgraded.close();
  const restarted = openDatabase(dir);
  assert.equal((restarted.sqlite.prepare("select count(*) as n from devspace_schema_migrations where version = 19").get() as { n: number }).n, 1);
  restarted.close();
});

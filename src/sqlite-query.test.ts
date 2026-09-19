import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { querySqliteReadOnly } from "./sqlite-query.js";

test("querySqliteReadOnly returns bounded rows from a read-only database", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-sqlite-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample.sqlite");
  const database = new Database(path);
  database.exec("create table items (id integer primary key, name text not null)");
  database.prepare("insert into items (name) values (?), (?)").run("alpha", "beta");
  database.close();

  const result = querySqliteReadOnly(
    path,
    "select id, name from items order by id",
    [],
    1,
  );

  assert.deepEqual(result.columns, ["id", "name"]);
  assert.deepEqual(result.rows, [{ id: 1, name: "alpha" }]);
  assert.equal(result.truncated, true);
});

test("querySqliteReadOnly rejects statements that can modify data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-sqlite-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample.sqlite");
  const database = new Database(path);
  database.exec("create table items (id integer primary key)");
  database.close();

  assert.throws(
    () => querySqliteReadOnly(path, "delete from items", [], 100),
    /only accepts one read-only statement/i,
  );
});

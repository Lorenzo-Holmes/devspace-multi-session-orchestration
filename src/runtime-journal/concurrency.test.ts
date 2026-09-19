import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeJournal } from "./store.js";
import { parsePolicy } from "../runtime-lifecycle/contracts.js";
const storeUrl = new URL(import.meta.url.endsWith(".ts") ? "./store.ts" : "./store.js", import.meta.url).href;
const processUrl = new URL(import.meta.url.endsWith(".ts") ? "../process-supervision/process.ts" : "../process-supervision/process.js", import.meta.url).href;
test("two real OS supervisors contend for one transactional owner", { skip: process.platform === "darwin" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-multi-owner-"));
  const policy = parsePolicy({}); const seed = new RuntimeJournal(dir, "multi-process", policy); seed.close();
  const script = `import {RuntimeJournal} from ${JSON.stringify(storeUrl)};
    import {selfIdentity,inspectProcess} from ${JSON.stringify(processUrl)};
    const j=new RuntimeJournal(process.argv[1],'multi-process',${JSON.stringify(policy)});
    try { j.acquire(selfIdentity(),inspectProcess,Date.now()); console.log('owner'); }
    catch(e) { console.log(e.message==='SUPERVISOR_ACTIVE'?'observer':'blocked'); }
    process.stdin.resume(); process.stdin.once('end',()=>{j.close();process.exit(0)});`;
  const children = [0, 1].map(() => spawn(process.execPath, [...process.execArgv.filter(x => !x.startsWith("--test")), "--input-type=module", "-e", script, dir], { stdio: ["pipe", "pipe", "pipe"] }));
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, "exit"); child.stdin.end(); await exit;
    }));
    rmSync(dir, { recursive: true, force: true });
  });
  const answers = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
    let out = "", err = ""; child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.trim()); });
    child.stderr.on("data", chunk => { err += chunk; }); child.once("error", reject);
    child.once("exit", code => { if (!out) reject(new Error(`fixture exited ${code}: ${err}`)); });
  })));
  const exits = children.map(child => { const exit = once(child, "exit"); child.stdin.end(); return exit; });
  await Promise.all(exits);
  assert.deepEqual(answers.sort(), ["observer", "owner"]);
});

test("OS process exit during an uncommitted metadata write preserves the previous journal", async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "devspace-journal-crash-")));
  const policy = parsePolicy({}), journal = new RuntimeJournal(dir, "crash-test", policy);
  t.after(() => { journal.close(); rmSync(dir, {recursive:true,force:true}); });
  const before = journal.read();
  const script = `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE runtime_snapshot SET body=? WHERE id=1').run('{partial');
    process.exit(23);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, journal.path], {stdio:"ignore"});
  const [code] = await once(child, "exit"); assert.equal(code, 23);
  assert.deepEqual(journal.read(), before);
});

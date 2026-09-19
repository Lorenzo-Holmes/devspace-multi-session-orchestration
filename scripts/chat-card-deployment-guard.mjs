import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {parse} from 'jsonc-parser';

// Deployment evidence and read-only invariants; never controls a Goal or selects a card answer.
const mode=process.argv[2];
assert.ok(['prepare','verify'].includes(mode));
const root='D:/DevSpace/devspace';
const candidate='D:/DevSpace-Goal-PoC/.poc/replan-v1/releases/chat-goal-card-preview-20260908-01';
const backup='D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/deploy-chat-card-20260908-01-before';
const configPath=join(root,'.devspace-config/config.jsonc');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await readFile(join(candidate,'release-manifest.json'),'utf8'));
assert.equal(manifest.buildId,'chat-goal-card-preview-20260908-01');
assert.equal(process.versions.node.split('.')[0],'24');
for(const [name,expected] of Object.entries(manifest.files)){
  const target=resolve(candidate,name), rel=relative(resolve(candidate),target);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  assert.equal(hash(await readFile(target)),expected,`Candidate file changed: ${name}`);
}
const configBytes=await readFile(configPath), config=parse(configBytes.toString('utf8'));
assert.equal(config.ui.enabled,true);
assert.equal(config.goals.enabled,false);
assert.equal(config.subagents.enabled,false);
assert.equal(config.chatGoals.enabled,true);
const {loadConfig}=await import(pathToFileURL(join(candidate,'dist/config.js')).href);
const loaded=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:join(root,'.devspace-config')});
assert.ok(!loaded.goals?.enabled);assert.equal(loaded.subagents.enabled,false);
assert.equal(loaded.chatGoals.enabled,true);
const pointer=JSON.parse(await readFile(join(root,'.devspace-release.json'),'utf8'));
const db=new Database(join(root,'.devspace-state/devspace.sqlite'),{readonly:true,fileMustExist:true});
try {
  const native=db.prepare('select * from managed_goal_bindings order by goal_ref').all();
  assert.ok(native.every(g=>['completed','stopped'].includes(g.control_state)),'Active native Goal prevents switching');
  const chat=db.prepare('select * from chat_goal_bindings order by goal_ref').all();
  assert.ok(chat.every(g=>!JSON.parse(g.metadata_json).lease),'Active Chat lease prevents switching');
  const hosted=JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'chat-goal-host-observe.mjs')],{encoding:'utf8',windowsHide:true}));
  const stableHosted={project:hosted.project,goals:hosted.goals,files:hosted.files};
  const state={recordedAt:new Date().toISOString(),configHash:hash(configBytes),
    authFileHash:hash(await readFile(join(root,'.devspace-config/auth.json'))),
    pointerHash:hash(await readFile(join(root,'.devspace-release.json'))),
    starterHash:hash(await readFile(join(root,'start-devspace.ps1'))),
    supervisorHash:hash(await readFile(join(root,'supervise-devspace.ps1'))),
    nativeRecordsHash:hash(JSON.stringify(native)),chatRecordsHash:hash(JSON.stringify(chat)),
    hostedStateHash:hash(JSON.stringify(stableHosted)),
    legacyTaskFileHash:hash(await readFile('D:/AgentState/_poc/shrimp/tasks.json')),
    schemaVersions:db.prepare('select version from devspace_schema_migrations order by version').all(),
    candidateFileCount:Object.keys(manifest.files).length,buildId:manifest.buildId,
    candidateServerHash:manifest.files['dist/server.js'],cardHtmlHash:manifest.files['dist/chat-card-probe.html']};
  if(mode==='prepare'){
    assert.equal(pointer.buildId,'chat-goal-preview-20260908-01');
    assert.equal(config.diagnostics,undefined);
    await mkdir(backup); // Exclusive: an earlier recovery point must never be replaced.
    for(const [source,name] of [[configPath,'config.jsonc'],[join(root,'.devspace-release.json'),'.devspace-release.json']])
      await copyFile(source,join(backup,name),constants.COPYFILE_EXCL);
    await db.backup(join(backup,'devspace.sqlite'));
    await writeFile(join(backup,'hosted-state.json'),JSON.stringify(stableHosted,null,2),{flag:'wx'});
    await writeFile(join(backup,'preflight.json'),JSON.stringify(state,null,2),{flag:'wx'});
  } else {
    const before=JSON.parse(await readFile(join(backup,'preflight.json'),'utf8'));
    const expected=parse(await readFile(join(backup,'config.jsonc'),'utf8'));
    expected.diagnostics={chatCard:true};
    assert.deepEqual(config,expected,'Unexpected configuration change');
    assert.equal(loaded.chatCardProbeEnabled,true);
    assert.equal(pointer.buildId,manifest.buildId);
    assert.equal(resolve(pointer.entryPoint),resolve(candidate,'dist/cli.js'));
    assert.equal(pointer.serverSha256,manifest.files['dist/server.js']);
    for(const key of ['authFileHash','starterHash','supervisorHash','nativeRecordsHash','chatRecordsHash','hostedStateHash','legacyTaskFileHash'])
      assert.equal(state[key],before[key],`Protected state changed: ${key}`);
    assert.deepEqual(state.schemaVersions,before.schemaVersions,'Unexpected schema migration');
  }
  console.log(JSON.stringify({result:'PASS',mode,...state,backup}));
}finally{db.close();}

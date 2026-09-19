import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {parse} from 'jsonc-parser';

// Backup and read-only comparison only. Never changes a release pointer,
// controls a service, creates a Goal, answers a card, or sends a Chat message.
const mode=process.argv[2]; assert.ok(['prepare','verify'].includes(mode));
assert.equal(process.versions.node.split('.')[0],'24');
const root='D:/DevSpace/devspace', buildId='chat-goal-card-preview-20260908-02';
const candidate=join('D:/DevSpace-Goal-PoC/.poc/replan-v1/releases',buildId);
const backup='D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/deploy-chat-card-20260908-02-before';
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifestBytes=await readFile(join(candidate,'release-manifest.json'));
const manifest=JSON.parse(manifestBytes.toString('utf8')); assert.equal(manifest.buildId,buildId);
for(const [name,expected] of Object.entries(manifest.files)){
  const target=resolve(candidate,name),rel=relative(resolve(candidate),target);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  assert.equal(hash(await readFile(target)),expected,`Candidate changed: ${name}`);
}
assert.equal(Object.keys(manifest.files).length,399);
const configPath=join(root,'.devspace-config/config.jsonc'),configBytes=await readFile(configPath);
const config=parse(configBytes.toString('utf8'));
assert.equal(config.ui.enabled,true);assert.equal(config.diagnostics.chatCard,true);
assert.equal(config.goals.enabled,false);assert.equal(config.subagents.enabled,false);assert.equal(config.chatGoals.enabled,true);
const {loadConfig}=await import(pathToFileURL(join(candidate,'dist/config.js')).href);
const loaded=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:join(root,'.devspace-config')});
assert.equal(loaded.chatCardProbeEnabled,true);assert.ok(!loaded.goals?.enabled&&!loaded.subagents.enabled&&loaded.chatGoals.enabled);
const pointerBytes=await readFile(join(root,'.devspace-release.json')),pointer=JSON.parse(pointerBytes.toString('utf8'));
const db=new Database(join(root,'.devspace-state/devspace.sqlite'),{readonly:true,fileMustExist:true});
try {
  const native=db.prepare('select * from managed_goal_bindings order by goal_ref').all();
  assert.ok(native.every(g=>['completed','stopped'].includes(g.control_state)),'Active native Goal blocks switch');
  const chat=db.prepare('select * from chat_goal_bindings order by goal_ref').all();
  assert.ok(chat.every(g=>!JSON.parse(g.metadata_json).lease),'Active Chat lease blocks switch');
  const hosted=JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'chat-goal-host-observe.mjs')],{encoding:'utf8',windowsHide:true}));
  const hostedState={project:hosted.project,goals:hosted.goals,files:hosted.files};
  const state={recordedAt:new Date().toISOString(),buildId,manifestHash:hash(manifestBytes),candidateFileCount:399,
    configHash:hash(configBytes),authFileHash:hash(await readFile(join(root,'.devspace-config/auth.json'))),
    pointerHash:hash(pointerBytes),starterHash:hash(await readFile(join(root,'start-devspace.ps1'))),
    supervisorHash:hash(await readFile(join(root,'supervise-devspace.ps1'))),
    nativeRecordsHash:hash(JSON.stringify(native)),chatRecordsHash:hash(JSON.stringify(chat)),
    chatRequestsHash:hash(JSON.stringify(db.prepare('select * from chat_goal_requests order by rowid').all())),
    hostedStateHash:hash(JSON.stringify(hostedState)),legacyTaskFileHash:hash(await readFile('D:/AgentState/_poc/shrimp/tasks.json')),
    schemaVersions:db.prepare('select version from devspace_schema_migrations order by version').all(),
    serverHash:manifest.files['dist/server.js'],cardHash:manifest.files['dist/chat-card-probe.html']};
  if(mode==='prepare'){
    assert.equal(pointer.buildId,'chat-goal-card-preview-20260908-01');
    const previous=JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'chat-card-deployment-guard.mjs'),'verify'],{encoding:'utf8',windowsHide:true}));
    assert.equal(previous.result,'PASS');
    await mkdir(backup); // Exclusive recovery point, never overwrites.
    for(const [source,name] of [[configPath,'config.jsonc'],[join(root,'.devspace-release.json'),'.devspace-release.json']])
      await copyFile(source,join(backup,name),constants.COPYFILE_EXCL);
    await db.backup(join(backup,'devspace.sqlite'));
    await writeFile(join(backup,'hosted-state.json'),JSON.stringify(hostedState,null,2),{flag:'wx'});
    await writeFile(join(backup,'preflight.json'),JSON.stringify(state,null,2),{flag:'wx'});
  }else{
    const before=JSON.parse(await readFile(join(backup,'preflight.json'),'utf8'));
    assert.equal(pointer.buildId,buildId);assert.equal(resolve(pointer.entryPoint),resolve(candidate,'dist/cli.js'));
    assert.equal(pointer.serverSha256,state.serverHash);
    for(const key of ['manifestHash','configHash','authFileHash','starterHash','supervisorHash','nativeRecordsHash','chatRecordsHash','chatRequestsHash','hostedStateHash','legacyTaskFileHash'])
      assert.equal(state[key],before[key],`Protected state changed: ${key}`);
    assert.deepEqual(state.schemaVersions,before.schemaVersions,'Unexpected migration');
  }
  console.log(JSON.stringify({result:'PASS',mode,backup,...state}));
}finally{db.close();}

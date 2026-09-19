import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {parse} from 'jsonc-parser';

const mode=process.argv[2];
assert.ok(['before-restart','after-restart'].includes(mode));
const serviceRoot='D:/DevSpace/devspace';
const backup='D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/deploy-chat-goal-20260908-01-before';
const hash=value=>createHash('sha256').update(value).digest('hex');
const before=JSON.parse(await readFile(join(backup,'preflight.json'),'utf8'));
const original=parse(await readFile(join(backup,'config.jsonc'),'utf8'));
const current=parse(await readFile(join(serviceRoot,'.devspace-config/config.jsonc'),'utf8'));
const chatGoals={enabled:true,shrimpEntryPoint:'D:\\DevSpace-Goal-PoC\\dist\\index.js',dataRoot:'D:\\AgentState\\_poc\\shrimp\\chat-goals-preview'};
const expected=structuredClone(original);expected.goals.enabled=false;expected.chatGoals=chatGoals;
assert.deepEqual(current,expected,'Unexpected production config change');
assert.equal(hash(await readFile(join(serviceRoot,'.devspace-config/auth.json'))),before.authFileHash,'Authentication file changed');
assert.equal(hash(await readFile('D:/AgentState/_poc/shrimp/tasks.json')),before.legacyTaskFileHash,'Legacy Shrimp task data changed');
const pointer=JSON.parse(await readFile(join(serviceRoot,'.devspace-release.json'),'utf8'));
assert.equal(pointer.buildId,'chat-goal-preview-20260908-01');
assert.equal(pointer.entryPoint,'D:\\DevSpace-Goal-PoC\\.poc\\replan-v1\\releases\\chat-goal-preview-20260908-01\\dist\\cli.js');
const dir=dirname(pointer.entryPoint);
for(const [file,expectedHash] of Object.entries({
  'server.js':'f068edf63dd65ec125294b8dea484e365fffecdc9269fc28b8c0e02a98e46afb',
  'chat-goal-controller.js':'bd769d5e8346d1c25211270725bbb045aded0740acc29600e0f2a694de445b91',
  'chat-goal-tools.js':'95f66c08676dcb42cd34878663b5eca12ce78ac82ba1bd335dd8a22fe8ff2fb9',
}))assert.equal(hash(await readFile(join(dir,file))),expectedHash,`Candidate ${file} changed`);
const {loadConfig}=await import(pathToFileURL(join(dir,'config.js')).href);
const loaded=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:join(serviceRoot,'.devspace-config')});
assert.ok(!loaded.goals?.enabled);assert.equal(loaded.subagents.enabled,false);assert.equal(loaded.chatGoals.enabled,true);
assert.equal(loaded.publicBaseUrl,before.publicBaseUrl);assert.equal(loaded.port,before.port);
const starterBefore=await readFile(join(backup,'start-devspace.ps1'),'utf8');
const starterNow=await readFile(join(serviceRoot,'start-devspace.ps1'),'utf8');
assert.equal(starterNow.replaceAll('\r\n','\n'),starterBefore.replace("'^web-goal-[a-z0-9-]+$'",()=>"'^(?:web|chat)-goal-[a-z0-9-]+$'").replaceAll('\r\n','\n'));
const db=new Database(join(serviceRoot,'.devspace-state/devspace.sqlite'),{readonly:true,fileMustExist:true});
try {
  const goals=db.prepare('select * from managed_goal_bindings order by goal_ref').all();
  assert.equal(hash(JSON.stringify(goals)),before.nativeGoalRecordsHash,'Historical native Goal records changed');
  const migrations=db.prepare('select version from devspace_schema_migrations order by version').all();
  if(mode==='before-restart')assert.deepEqual(migrations,before.schemaVersions);
  else assert.ok(migrations.some(m=>m.version===10),'Chat schema migration absent');
  console.log(JSON.stringify({result:'PASS',mode,release:pointer.buildId,authUnchanged:true,allowedRootsUnchanged:true,nativeGoalHistoryUnchanged:true,legacyShrimpTasksUnchanged:true,noNativeGoalOrSubagentRuntime:true,schemaVersion:migrations.at(-1).version}));
}finally{db.close();}

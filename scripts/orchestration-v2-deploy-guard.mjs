import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import Database from 'better-sqlite3';

// Snapshot/verify only. The existing start-devspace.ps1 owns production process lifecycle.
const [mode,buildId,rollbackId]=process.argv.slice(2);
assert.ok(['prepare','verify'].includes(mode));
for(const id of [buildId,rollbackId])assert.match(id??'',/^chat-goal-card-preview-\d{8}-\d{2}$/);
assert.notEqual(buildId,rollbackId);
const service='D:/DevSpace/devspace', releases='D:/DevSpace-Goal-PoC/.poc/replan-v1/releases';
const evidence=join('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence',`deploy-${buildId}-before`);
const hash=b=>createHash('sha256').update(b).digest('hex');
const parseJson=bytes=>JSON.parse(bytes.toString().replace(/^\uFEFF/,''));
async function verifyRelease(id){
  const root=join(releases,id), bytes=await readFile(join(root,'release-manifest.json')),manifest=parseJson(bytes);
  assert.equal(manifest.buildId,id);
  for(const [name,expected] of Object.entries(manifest.files)){
    const path=resolve(root,name),rel=relative(root,path);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    assert.equal(hash(await readFile(path)),expected,`Immutable release changed: ${id}/${name}`);
  }
  return {manifest,manifestHash:hash(bytes),fileCount:Object.keys(manifest.files).length};
}
const candidate=await verifyRelease(buildId),rollback=await verifyRelease(rollbackId);
assert.equal(candidate.manifest.databaseMigrationVersion,18);
assert.equal(candidate.manifest.toolSchemaVersion,'2026-09-19.4');
const pointerBytes=await readFile(join(service,'.devspace-release.json')),pointer=parseJson(pointerBytes);
const protectedFiles={};
for(const path of ['.devspace-config/config.jsonc','.devspace-config/auth.json','start-devspace.ps1','supervise-devspace.ps1','devspace-lifecycle.ps1']){
  protectedFiles[path]=hash(await readFile(join(service,path)));
}
const db=new Database(join(service,'.devspace-state/devspace.sqlite'),{readonly:true,fileMustExist:true});
try{
  const native=db.prepare('select * from managed_goal_bindings order by goal_ref').all();
  const chat=db.prepare('select * from chat_goal_bindings order by goal_ref').all();
  assert.ok(native.every(g=>['completed','stopped'].includes(g.control_state)),'Active native Goal blocks switch');
  assert.ok(chat.every(g=>!g.inflight_key),'In-flight Chat operation blocks switch');
  assert.ok(chat.every(g=>{const lease=JSON.parse(g.metadata_json).lease;return !lease||lease.expiresAt<=Date.now();}),'Active Chat lease blocks switch');
  const history={native:hash(JSON.stringify(native)),chat:hash(JSON.stringify(chat)),requests:hash(JSON.stringify(db.prepare('select * from chat_goal_requests order by rowid').all()))};
  const schema=db.prepare('select version,name from devspace_schema_migrations order by version').all();
  const state={recordedAt:new Date().toISOString(),buildId,rollbackId,protectedFiles,history,schema,
    candidateManifestHash:candidate.manifestHash,rollbackManifestHash:rollback.manifestHash,
    candidateFiles:candidate.fileCount,rollbackFiles:rollback.fileCount,
    legacyTasksHash:hash(await readFile('D:/AgentState/_poc/shrimp/tasks.json'))};
  if(mode==='prepare'){
    assert.equal(pointer.buildId,rollbackId);
    await mkdir(evidence);
    await copyFile(join(service,'.devspace-release.json'),join(evidence,'rollback-pointer.json'),constants.COPYFILE_EXCL);
    await copyFile(join(service,'.devspace-config/config.jsonc'),join(evidence,'config.jsonc'),constants.COPYFILE_EXCL);
    await db.backup(join(evidence,'devspace.sqlite'));
    await writeFile(join(evidence,'preflight.json'),JSON.stringify(state,null,2),{flag:'wx'});
  }else{
    const before=JSON.parse(await readFile(join(evidence,'preflight.json'),'utf8'));
    assert.equal(pointer.buildId,buildId);
    assert.equal(resolve(pointer.entryPoint),resolve(candidate.manifest.entryPoint));
    assert.equal(pointer.serverSha256,candidate.manifest.files['dist/server.js']);
    for(const key of ['protectedFiles','history','candidateManifestHash','rollbackManifestHash','legacyTasksHash'])assert.deepEqual(state[key],before[key],`Protected state changed: ${key}`);
    assert.deepEqual(schema.slice(0,before.schema.length),before.schema,'Previously applied migrations changed');
    assert.equal(schema.at(-1).version,18);
    for(let i=0;i<schema.length;i++)assert.equal(schema[i].version,i+1);
    await writeFile(join(evidence,'post-deploy-verified.json'),JSON.stringify(state,null,2),{flag:'wx'});
  }
  console.log(JSON.stringify({result:'PASS',mode,evidence,buildId,rollbackId,schemaVersion:schema.at(-1).version,candidateFiles:candidate.fileCount,rollbackFiles:rollback.fileCount,rollbackManifestHash:rollback.manifestHash}));
}finally{db.close();}

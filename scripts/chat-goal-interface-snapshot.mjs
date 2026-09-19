import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,lstat,realpath,writeFile} from 'node:fs/promises';
import {join,relative,resolve,isAbsolute} from 'node:path';
import Database from 'better-sqlite3';

// Read-only fingerprint of the EXACT real acceptance case and service files.
// No model, command execution, controller instance or production DB writes.
const mode=process.argv[2];assert.ok(['before','after','after-deploy'].includes(mode));
const evidence='D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence';
const label=process.argv[3];assert.match(label??'',/^interface-\d{8}-\d{2}$/);
const base=join(evidence,`${label}-before.json`),output=join(evidence,`${label}-${mode}.json`);
const hash=value=>createHash('sha256').update(value).digest('hex');
const project=resolve('D:/DevSpace-Goal-PoC/user-acceptance/chat-card-goal-20260909-01');
assert.equal((await realpath(project)).toLowerCase(),project.toLowerCase());
const goalRef='chatgoal_3a9a56378f50e836e072ffdc19f0a1f8';
const db=new Database('D:/DevSpace/devspace/.devspace-state/devspace.sqlite',{readonly:true,fileMustExist:true});
let snapshot;
try{
  const row=db.prepare('select * from chat_goal_bindings where goal_ref=?').get(goalRef);assert.ok(row);
  const g=JSON.parse(row.metadata_json);assert.equal(g.workspaceRoot.toLowerCase(),project.toLowerCase());
  const dataRoot=resolve('D:/AgentState/_poc/shrimp/chat-goals-preview'),dataDir=await realpath(g.dataDir),rel=relative(dataRoot,dataDir);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(dataDir.toLowerCase(),resolve(g.dataDir).toLowerCase());
  const tasks=await readFile(join(dataDir,'tasks.json'));
  const files={};
  async function walk(dir=''){
    for(const name of (await readdir(join(project,dir))).sort()){
      const path=join(dir,name),full=join(project,path),stat=await lstat(full);assert.ok(!stat.isSymbolicLink());
      if(stat.isDirectory())await walk(path);else if(stat.isFile())files[path.replaceAll('\\','/')]=hash(await readFile(full));
    }
  }
  await walk();
  const serviceFiles={};
  for(const path of ['.devspace-release.json','.devspace-config/config.jsonc','.devspace-config/auth.json','start-devspace.ps1','supervise-devspace.ps1'])
    serviceFiles[path]=hash(await readFile(join('D:/DevSpace/devspace',path)));
  const pointer=JSON.parse(await readFile('D:/DevSpace/devspace/.devspace-release.json','utf8'));
  snapshot={goalRef,goalRecordHash:hash(JSON.stringify(row)),journalHash:hash(JSON.stringify(db.prepare('select * from chat_goal_requests where goal_ref=? order by rowid').all(goalRef))),
    revision:g.revision,state:g.state,hasLease:!!g.lease,inflight:!!row.inflight_key,
    taskHash:hash(tasks),tasks:JSON.parse(tasks).tasks.map(t=>({id:t.id,name:t.name,status:t.status})),
    files,serviceFiles,buildId:pointer.buildId,legacyTaskHash:hash(await readFile('D:/AgentState/_poc/shrimp/tasks.json'))};
}finally{db.close();}
if(mode!=='before'){
  const before=JSON.parse(await readFile(base,'utf8')).snapshot;
  if(mode==='after-deploy'){
    const build=process.argv[4];assert.match(build??'',/^chat-goal-card-preview-\d{8}-\d{2}$/);
    assert.notEqual(before.buildId,build);assert.equal(snapshot.buildId,build);
    const candidate=join('D:/DevSpace-Goal-PoC/.poc/replan-v1/releases',build);
    const manifest=JSON.parse(await readFile(join(candidate,'release-manifest.json'),'utf8'));
    const pointer=JSON.parse(await readFile('D:/DevSpace/devspace/.devspace-release.json','utf8'));
    assert.equal(resolve(pointer.entryPoint),resolve(candidate,'dist/cli.js'));
    assert.equal(pointer.serverSha256,manifest.files['dist/server.js']);
    // Permit exactly the explicitly authorized release pointer change.
    before.buildId=build;before.serviceFiles['.devspace-release.json']=snapshot.serviceFiles['.devspace-release.json'];
  }
  assert.deepEqual(snapshot,before,'Protected production state changed; do not overwrite it.');
}
const result=mode==='before'?'BASELINE':mode==='after-deploy'?'PASS_ONLY_RELEASE_POINTER_CHANGED':'PASS_UNCHANGED';
await writeFile(output,JSON.stringify({recordedAt:new Date().toISOString(),result,snapshot},null,2),{flag:'wx'});
console.log(JSON.stringify({result,evidence:output,revision:snapshot.revision,state:snapshot.state,hasLease:snapshot.hasLease,buildId:snapshot.buildId}));

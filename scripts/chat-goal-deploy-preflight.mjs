import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {parse} from 'jsonc-parser';

const serviceRoot='D:/DevSpace/devspace';
const backup='D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/deploy-chat-goal-20260908-01-before';
const hash=value=>createHash('sha256').update(value).digest('hex');
const configPath=join(serviceRoot,'.devspace-config/config.jsonc');
const configBytes=await readFile(configPath);
const config=parse(configBytes.toString('utf8'));
const db=new Database(join(serviceRoot,'.devspace-state/devspace.sqlite'),{readonly:true,fileMustExist:true});
try {
  const goals=db.prepare('select * from managed_goal_bindings order by goal_ref').all();
  assert.ok(goals.every(g=>['completed','stopped'].includes(g.control_state)),'Active native Goal prevents switching');
  for(const [source,name] of [[configPath,'config.jsonc'],[join(serviceRoot,'start-devspace.ps1'),'start-devspace.ps1'],[join(serviceRoot,'.devspace-release.json'),'.devspace-release.json']]) {
    assert.equal(hash(await readFile(source)),hash(await readFile(join(backup,name))),'Backup mismatch');
  }
  const destination=join(backup,'devspace.sqlite');
  let exists=true;try{await access(destination);}catch{exists=false;}
  assert.equal(exists,false,'Never overwrite a database backup');
  await db.backup(destination);
  const report={recordedAt:new Date().toISOString(),configHash:hash(configBytes),
    authFileHash:hash(await readFile(join(serviceRoot,'.devspace-config/auth.json'))),
    pointerHash:hash(await readFile(join(serviceRoot,'.devspace-release.json'))),
    starterHash:hash(await readFile(join(serviceRoot,'start-devspace.ps1'))),
    allowedRoots:config.workspaces.allowedRoots,
    nativeGoalRecordsHash:hash(JSON.stringify(goals)),nativeGoalCount:goals.length,activeNativeGoals:0,
    schemaVersions:db.prepare('select version from devspace_schema_migrations order by version').all(),
    legacyTaskFileHash:hash(await readFile('D:/AgentState/_poc/shrimp/tasks.json')),
    publicBaseUrl:config.server.publicBaseUrl,port:config.server.port,
  };
  await writeFile(join(backup,'preflight.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({backupComplete:true,activeNativeGoals:0,nativeGoalCount:goals.length,publicBaseUrl:report.publicBaseUrl}));
}finally{db.close();}

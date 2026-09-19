import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve,relative} from 'node:path';
import Database from 'better-sqlite3';

// Read-only observation of the exact approved hosted Chat test; never drives it or answers its form.
const project='D:\\DevSpace-Goal-PoC\\user-acceptance\\chat-preview-01';
const dataRoot='D:\\AgentState\\_poc\\shrimp\\chat-goals-preview';
const db=new Database('D:/DevSpace/devspace/.devspace-state/devspace.sqlite',{readonly:true,fileMustExist:true});
let result;
try{
  const rows=db.prepare('select metadata_json from chat_goal_bindings where workspace_root=?').all(resolve(project).toLowerCase());
  const goals=[];
  for(const row of rows){
    const g=JSON.parse(row.metadata_json);
    const rel=relative(resolve(dataRoot),resolve(g.dataDir));
    assert.ok(rel&&!rel.startsWith('..')&&!rel.includes(':'));
    const taskFile=JSON.parse(await readFile(join(g.dataDir,'tasks.json'),'utf8'));
    goals.push({goalRef:g.goalRef,revision:g.revision,state:g.state,decision:g.decision??null,
      lease:g.lease?{taskId:g.lease.taskId,expiresAt:g.lease.expiresAt}:null,
      error:g.error??null,taskCommit:g.taskCommit,proofs:g.proofs,
      tasks:taskFile.tasks.map(t=>({id:t.id,name:t.name,status:t.status,dependencies:t.dependencies})),
      requestJournal:db.prepare('select request_key,response_json is not null as has_response from chat_goal_requests where goal_ref=? order by rowid').all(g.goalRef)});
  }
  const files=[];
  for(const name of await readdir(project))if(['TECH.md','app.mjs','TEST.md'].includes(name)){
    const bytes=await readFile(join(project,name));files.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  result={observedAt:new Date().toISOString(),scope:'Read-only exact hosted Chat acceptance directory; no task control calls',project,goals,files};
}finally{db.close();}
const evidence=process.argv[2];
if(evidence){assert.match(evidence,/^host-chat-[a-z0-9-]+\.json$/);await writeFile(join('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence',evidence),JSON.stringify(result,null,2),{flag:'wx'});}
console.log(JSON.stringify(result));

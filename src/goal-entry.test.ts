import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {goalSpecSchema,goalRequestSchema} from './goal-contracts.js';
import {registerGoalTools} from './goal-tools.js';
import {GoalBindingStore} from './goal-binding-store.js';
import {scopedArtifacts,projectGit} from './goal-evidence.js';
import type {WorkspaceRegistry} from './workspaces.js';
import type {WorkspaceAccessManager} from './workspace-access.js';

test('Goal contracts reject placeholders, model-supplied authority and stale-shape controls',()=>{
  assert.equal(goalSpecSchema.safeParse({objective:'【在这里填写你实际想完成的事情】',successCriteria:'files'}).success,false);
  assert.equal(goalRequestSchema.safeParse({action:'resume',ownerRef:'user',goalRef:'goal',requestKey:'key',expectedRevision:0}).success,false);
  assert.equal(goalSpecSchema.safeParse({objective:'Create a document',successCriteria:'Readable document',ownerRef:'other'}).success,false);
});
test('all six Goal tools are text-only and reject unauthenticated identity spoofing',async()=>{
  const server=new McpServer({name:'goal-entry-contract',version:'1'}),client=new Client({name:'test',version:'1'});
  let calls=0;
  registerGoalTools(server,{goal:async()=>{calls++;return {ok:true,data:{}};}},{} as WorkspaceRegistry,{} as WorkspaceAccessManager);
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try {
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.map(t=>t.name).sort(),['goal_start','goal_status','goal_list','goal_pause','goal_resume','goal_stop'].sort());
    assert.ok(tools.every(t=>!t._meta?.['openai/outputTemplate']));
    assert.ok(tools.every(t=>!('ownerRef' in (t.inputSchema.properties??{}))));
    for(const name of ['goal_status','goal_list']) {
      const r=await client.callTool({name,arguments:name==='goal_status'?{goalRef:'a'}:{},_meta:{devspaceOwnerRef:'single-user'}});
      assert.equal(r.isError,true);assert.match(JSON.stringify(r),/AUTHENTICATION_REQUIRED/);
    }
    assert.equal(calls,0);
  }finally{await client.close();await server.close();}
});
test('creation keys bind the entire spec; completion releases the workspace without deleting history',async()=>{
  const root=await mkdtemp(join(tmpdir(),'goal-binding-preview-')),store=new GoalBindingStore(join(root,'state'));
  try {
    const input={ownerRef:'owner',workspaceRoot:join(root,'project'),dataDir:join(root,'tasks-a'),requestKey:'a',spec:{objective:'First'}};
    const a=store.prepare(input);assert.equal(store.prepare(input).goalRef,a.goalRef);
    assert.throws(()=>store.prepare({...input,spec:{objective:'Changed'}}),/REQUEST_KEY_CONFLICT/);
    let b=store.bind('owner',a.goalRef,a.revision,'thread-one');
    b=store.control({ownerRef:'owner',goalRef:b.goalRef,expectedRevision:b.revision,expectedEpoch:b.ownerEpoch,requestKey:'done',state:'completed'});
    assert.throws(()=>store.control({ownerRef:'owner',goalRef:b.goalRef,expectedRevision:b.revision,expectedEpoch:b.ownerEpoch,requestKey:'restart',state:'running'}),/completed/);
    assert.notEqual(store.prepare({...input,dataDir:join(root,'tasks-b'),requestKey:'b'}).goalRef,b.goalRef);
    assert.equal(store.all('owner').length,2);assert.equal(store.all('other').length,0);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('artifact evidence requires real scoped non-empty bytes and Git records LF checkpoints',async()=>{
  const root=await mkdtemp(join(tmpdir(),'goal-evidence-')),project=join(root,'project');await mkdir(project);
  try {
    await writeFile(join(project,'a.md'),'Actual artifact\n');await writeFile(join(project,'empty.md'),'');
    const proof=await scopedArtifacts(project,['a.md']);assert.equal(proof[0].sha256.length,64);
    await assert.rejects(scopedArtifacts(project,['../outside.md']),/permitted/);
    await assert.rejects(scopedArtifacts(project,['empty.md']),/non-empty/);
    projectGit(project,'init');projectGit(project,'add','--','a.md');projectGit(project,'commit','-m','test');
    assert.equal(projectGit(project,'show','HEAD:a.md'),'Actual artifact');
    await assert.rejects(scopedArtifacts(project,['.git/config']),/permitted/);
    const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'private.md'),'not permitted');
    await symlink(outside,join(project,'alias'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(scopedArtifacts(project,['alias/private.md']),/aliases/);
  }finally{await rm(root,{recursive:true,force:true});}
});

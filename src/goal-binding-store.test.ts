import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { GoalBindingStore } from './goal-binding-store.js';
const root=join(process.cwd(),'.goal-test-evidence');
import {mkdirSync} from 'node:fs';mkdirSync(root,{recursive:true});
test('bindings survive restart; scoped reads, creation deduplication and project lock',()=>{
 const state=mkdtempSync(join(root,'binding-'));
 let store=new GoalBindingStore(state);
 const input={ownerRef:'owner-a',requestKey:'create-1',workspaceRoot:join(state,'project'),dataDir:join(state,'tasks')};
 const first=store.prepare(input);
 assert.deepEqual(store.prepare(input),first);
 assert.throws(()=>store.prepare({...input,requestKey:'other'}),/GOAL_BUSY/);
 assert.throws(()=>store.prepare({...input,dataDir:join(state,'different')}),/CONFLICT/);
 assert.throws(()=>store.get('owner-b',first.goalRef),/NOT_FOUND/);
 const bound=store.bind('owner-a',first.goalRef,first.revision,'native-thread-1');
 store.close();store=new GoalBindingStore(state);
 assert.equal(store.get('owner-a',first.goalRef).providerSessionId,'native-thread-1');
 assert.equal(store.list('owner-b',input.workspaceRoot).length,0);
 assert.equal(store.list('owner-a',input.workspaceRoot).length,1);
 store.close();assert.equal(bound.revision,2);
});
test('control CAS, idempotent retries, old epoch rejection, stop is terminal',()=>{
 const state=mkdtempSync(join(root,'control-'));const store=new GoalBindingStore(state);
 try{
 let b=store.prepare({ownerRef:'owner',requestKey:'new',workspaceRoot:join(state,'p'),dataDir:join(state,'d')});
 b=store.bind('owner',b.goalRef,b.revision,'native-thread-2');
 const command={ownerRef:'owner',goalRef:b.goalRef,expectedRevision:b.revision,expectedEpoch:b.ownerEpoch,requestKey:'run',state:'running' as const};
 b=store.control(command);assert.deepEqual(store.control(command),b);
 assert.throws(()=>store.control({...command,state:'stopped'}),/CONFLICT/);
 b=store.fenceForRecovery('owner',b.goalRef,b.revision);
 assert.throws(()=>store.control({...command,requestKey:'late',expectedRevision:b.revision}),/STALE/);
 b=store.control({...command,requestKey:'stop',expectedRevision:b.revision,expectedEpoch:b.ownerEpoch,state:'stopped'});
 assert.throws(()=>store.control({...command,requestKey:'resume',expectedRevision:b.revision,expectedEpoch:b.ownerEpoch}),/Stopped/);
 }finally{store.close();}
});

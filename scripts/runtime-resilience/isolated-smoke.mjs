import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRuntimeConfig } from '../../dist/runtime-supervisor/config.js';
import { NativeRuntimeAdapter, systemClock } from '../../dist/runtime-supervisor/native.js';
import { RuntimeSupervisor } from '../../dist/runtime-supervisor/supervisor.js';
import { RuntimeJournal } from '../../dist/runtime-journal/store.js';
import { selfIdentity, inspectProcess, terminateVerified } from '../../dist/process-supervision/process.js';
const root = mkdtempSync(join(tmpdir(), 'devspace-runtime-smoke-'));
const instance = join(root, 'approved'); mkdirSync(instance);
const state = join(root, 'state'); mkdirSync(state, {mode:0o700});
const entrypoint = join(instance, 'fixture.mjs');
const fixtureUrl = new URL('../../dist/service-health/test-fixture.js', import.meta.url).href;
const listener = createServer(); await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port = listener.address().port; await new Promise(resolve=>listener.close(resolve));
const token = 'isolated-fixture-token';
const oldToken = process.env.DEVSPACE_RUNTIME_HEALTH_TOKEN;
process.env.DEVSPACE_RUNTIME_HEALTH_TOKEN = token;
writeFileSync(entrypoint, `import {mcpFixture} from ${JSON.stringify(fixtureUrl)};
const fixture=await mcpFixture({token:${JSON.stringify(token)},buildId:'fixture-build',serverVersion:'fixture-version',crash:()=>process.exit(19)},${port});
process.once('SIGTERM',()=>void fixture.close().then(()=>process.exit(0)));
`);
writeFileSync(join(root,'active.json'),JSON.stringify({entryPoint:entrypoint,buildId:'fixture-build'}));
writeFileSync(join(root,'runtime.json'),JSON.stringify({stateDirectory:state,instanceRoot:instance,activeReleaseFile:join(root,'active.json'),serverVersion:'fixture-version',localUrl:`http://127.0.0.1:${port}`,runtimeRecovery:{enabled:true,pollMs:100,initialBackoffMs:200,maxBackoffMs:1000,healthTimeoutMs:5000,stopTimeoutMs:2000}}));
const config = loadRuntimeConfig(join(root,'runtime.json'));
const journal = new RuntimeJournal(state,config.rootId,config.policy);
const owner = journal.acquire(selfIdentity(),inspectProcess,Date.now());
const supervisor = new RuntimeSupervisor(journal,owner,new NativeRuntimeAdapter(config),systemClock,()=>0.5);
async function until(predicate,label) {
  const deadline=Date.now()+15000;
  do { await supervisor.tick(); if(predicate(journal.read())) return; await delay(100); } while(Date.now()<deadline);
  throw new Error(`${label}: ${JSON.stringify(journal.read().slots.server)}`);
}
let result;
try {
  await until(s=>s.runtimeState==='healthy','initial health');
  const first=journal.read().slots.server.identity;
  await fetch(`http://127.0.0.1:${port}/fixture-crash`,{headers:{authorization:`Bearer ${token}`}});
  await until(s=>s.runtimeState==='healthy'&&s.slots.server.identity?.generation>first.generation,'bounded crash recovery');
  const second=journal.read().slots.server.identity;
  assert.notEqual(first.pid,second.pid);
  journal.control('stop'); await until(s=>s.runtimeState==='stopped','intentional stop');
  const generation=journal.read().runtimeGeneration;
  for(let i=0;i<4;i++){await supervisor.tick();await delay(100);}
  assert.equal(journal.read().runtimeGeneration,generation);
  journal.release(owner,true); assert.equal(journal.read().cleanShutdown,true);
  result={result:'PASS',scope:'isolated fixture exercising the real worker, journal, OS identity, HTTP/MCP probe and supervisor; not production DevSpace',starts:generation,initialPid:first.pid,recoveredPid:second.pid,intentionalStop:true,cleanShutdown:true};
} finally {
  const identity=journal.read().slots.server.identity;
  if(identity) terminateVerified(identity,true);
  journal.close(); await delay(100); rmSync(root,{recursive:true,force:true});
  if(oldToken===undefined) delete process.env.DEVSPACE_RUNTIME_HEALTH_TOKEN; else process.env.DEVSPACE_RUNTIME_HEALTH_TOKEN=oldToken;
}
console.log(JSON.stringify(result,null,2));

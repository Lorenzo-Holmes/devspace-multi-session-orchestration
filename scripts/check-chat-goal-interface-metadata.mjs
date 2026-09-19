import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

// tools/list only; no controller instance, database, workspace or task calls.
const releases='D:/DevSpace-Goal-PoC/.poc/replan-v1/releases';
const builds=process.argv.slice(2);assert.equal(builds.length,2);
for(const build of builds)assert.match(build,/^chat-goal-card-preview-\d{8}-\d{2}$/);
assert.notEqual(builds[0],builds[1]);
async function metadata(build){
  const {registerChatGoalTools}=await import(pathToFileURL(join(releases,build,'dist/chat-goal-tools.js')).href);
  const server=new McpServer({name:'metadata-only isolated check',version:'1'}),client=new Client({name:'metadata-only',version:'1'});
  // No stub is ever invoked. Only registration and official tools/list run.
  registerChatGoalTools(server,{}, {}, {},{service:{},html:'',scope:'devspace'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try{return (await client.listTools()).tools;}finally{await client.close();await server.close();}
}
const [before,after]=await Promise.all(builds.map(metadata));
assert.equal(before.length,14);assert.equal(after.length,14);
for(const tool of after){
  const old=before.find(t=>t.name===tool.name);assert.ok(old);
  const {outputSchema:newSchema,...newDescriptor}=tool,{outputSchema:oldSchema,...oldDescriptor}=old;
  assert.deepEqual(newDescriptor,oldDescriptor,`${tool.name}: non-output metadata changed`);
  assert.equal(oldSchema,undefined);assert.equal(newSchema.type,'object');assert.ok(newSchema.properties.data);
  assert.ok(!JSON.stringify(newSchema).includes('submitToken'));
}
const result={result:'PASS_METADATA_ONLY',before:builds[0],after:builds[1],tools:after.map(t=>t.name),
  toolsCompared:14,onlyDescriptorChange:'outputSchema',unchanged:['names','titles','descriptions','inputSchema','annotations','_meta/auth/UI visibility'],
  beforeBytes:Buffer.byteLength(JSON.stringify(before)),afterBytes:Buffer.byteLength(JSON.stringify(after)),
  liveHostMetadataVerified:false,goalOperations:0};
const output=join('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence',`${builds[1]}-metadata.json`);
await writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({...result,evidence:output}));

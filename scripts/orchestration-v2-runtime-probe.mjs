import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {toolCatalogFingerprints} from './release-contract.mjs';

const service='D:/DevSpace/devspace';
const parseJson=bytes=>JSON.parse(bytes.toString().replace(/^\uFEFF/,''));
const pointer=parseJson(await readFile(join(service,'.devspace-release.json'),'utf8'));
const moduleDir=join(pointer.entryPoint,'..');
const {loadConfig}=await import(pathToFileURL(join(moduleDir,'config.js')));
const config=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:join(service,'.devspace-config')});
const origin=process.argv[2]==='public'?config.publicBaseUrl:`http://127.0.0.1:${config.port}`;
// OAuth resource is the configured audience even for the loopback transport.
const resource=new URL('/mcp',config.publicBaseUrl).href, transportUrl=new URL('/mcp',origin);
const request=(path,options={})=>fetch(new URL(path,origin),{...options,signal:AbortSignal.timeout(15000)});
const redirect='http://127.0.0.1/callback',client=new Client({name:'DevSpace V2 deployment read-only verification; no model',version:'1'});
let tokens,clientId;
try{
  const health=await request('/healthz');assert.equal(health.status,200);
  const reg=await request('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'DevSpace V2 runtime read-only probe',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(reg.status,201);clientId=(await reg.json()).client_id;
  const verifier=randomUUID()+randomUUID(),challenge=createHash('sha256').update(verifier).digest('base64url');
  const auth=await request('/authorize',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,scope:config.oauth.scopes[0],resource,code_challenge:challenge,code_challenge_method:'S256',owner_token:config.oauth.ownerToken})});
  assert.equal(auth.status,302);const code=new URL(auth.headers.get('location')).searchParams.get('code');
  const exchange=await request('/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource})});
  assert.equal(exchange.status,200);tokens=await exchange.json();
  await client.connect(new StreamableHTTPClientTransport(transportUrl,{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
  const tools=(await client.listTools()).tools;
  const names=tools.map(t=>t.name).sort();
  const catalogFingerprints=toolCatalogFingerprints(tools);
  if(process.argv[4]){
    assert.match(process.argv[4],/^[a-f0-9]{64}$/,'Trusted definition fingerprint must be SHA-256');
    assert.equal(catalogFingerprints.toolCatalogDefinitionFingerprint,process.argv[4],'Observed tool definitions changed');
  }
  const modelNames=tools.filter(t=>!Array.isArray(t._meta?.ui?.visibility)||t._meta.ui.visibility.includes('model')).map(t=>t.name).sort();
  const runtime=(await client.callTool({name:'devspace_runtime_info',arguments:{}})).structuredContent;
  assert.equal(runtime.buildId,pointer.buildId);
  assert.equal(runtime.toolCatalogCount,names.length);
  assert.equal(runtime.toolCatalogFingerprint,createHash('sha256').update(names.join('\n')).digest('hex'));
  assert.equal(runtime.toolCatalogFingerprint,catalogFingerprints.toolCatalogNameFingerprint);
  const processInfo=parseJson(await readFile(join(service,'.devspace-process.json'),'utf8'));
  const result={result:'PASS',observedAt:new Date().toISOString(),origin,consumer:'Official MCP SDK, not a ChatGPT conversation',runtime,pid:processInfo.pid,serverToolCount:names.length,modelVisibleToolCount:modelNames.length,tools:names,...catalogFingerprints};
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify(result));
}finally{
  await client.close().catch(()=>{});
  if(tokens)for(const type of ['access_token','refresh_token'])if(tokens[type]){
    const revoked=await request('/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,token:tokens[type],token_type_hint:type})});
    assert.equal(revoked.status,200);await revoked.arrayBuffer();
  }
}

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ChatCardProbe, registerChatCardProbe } from '../../dist/chat-card-probe.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
assert.equal(resolve(root).toLowerCase(),resolve('D:/DevSpace-Goal-PoC/.poc/replan-v1/devspace').toLowerCase());
const evidence=await mkdtemp(join(root,'../evidence/card-lab-'));
const cardScript=await readFile(join(root,'.card-lab-build/card.js'),'utf8');
// Use a callback: replacement-string $&/$` sequences inside bundled JS must
// remain literal, or the HTML insertion can silently corrupt the script.
const embeddedScript=cardScript.replaceAll('</script','<\\/script');
const cardHtml=(await readFile(join(root,'scripts/card-lab/card.html'),'utf8')).replace('<!--CARD_SCRIPT-->',()=>`<script>${embeddedScript}</script>`);
assert.ok(cardHtml.includes(embeddedScript));
const hostHtml=await readFile(join(root,'scripts/card-lab/host.html'),'utf8'),hostScript=await readFile(join(root,'.card-lab-build/host.js'));
const waitArg=process.argv.slice(2).find(a=>a.startsWith('--wait-ms='));
const waitMs=waitArg ? Number(waitArg.slice('--wait-ms='.length)) : 45000;
assert.ok(Number.isInteger(waitMs) && waitMs>=1 && waitMs<=50000);
const probe=new ChatCardProbe({waitMs}), sessions=new Map(), observations=[];
const labToken=randomBytes(32).toString('hex'),app=express(),http=createServer(app);
let origin,closed=false;
app.use((req,res,next)=>{
  if(req.headers.host!==new URL(origin).host || (req.headers.origin && req.headers.origin!==origin)) return res.sendStatus(403);
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  next();
});
app.use(express.json({limit:'100kb'}));
app.get('/',(_req,res)=>res.type('html').send(hostHtml));
app.get('/host.js',(_req,res)=>res.type('js').send(hostScript));
// Ephemeral credential for this loopback-only lab with diagnostic tools only.
// It is not DevSpace OAuth and grants no real workspace or account authority.
app.get('/lab-config',(_req,res)=>res.json({labToken,waitMs}));
app.use((req,res,next)=>{
  if(req.headers.authorization!==`Bearer ${labToken}`) return res.sendStatus(401);
  req.auth={token:labToken,clientId:'isolated-card-lab',scopes:[],extra:{devspaceOwnerRef:'isolated-card-lab-owner'}};
  next();
});
app.get('/lab-state',(_req,res)=>res.json({scope:'isolated_simulated_host',observations,probes:probe.snapshot()}));
app.post('/lab-observation',(req,res)=>{observations.push(req.body);res.json({recorded:true});});
app.post('/lab-stop',(_req,res)=>{res.json({stoppingOnlyThisLab:true});setTimeout(()=>void close(),30);});
app.all('/mcp',async(req,res)=>{
  try {
    const sessionId=req.header('mcp-session-id');let entry=sessions.get(sessionId);
    if(!entry && !sessionId && req.method==='POST' && isInitializeRequest(req.body)) {
      if(sessions.size>=8) return res.sendStatus(429);
      const server=new McpServer({name:'Isolated Chat card lab — no Goal/workspace/model tools',version:'1'});
      registerChatCardProbe(server,probe,cardHtml);
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:id=>sessions.set(id,{server,transport})});
      entry={server,transport};await server.connect(transport);
      transport.onclose=()=>sessions.delete(transport.sessionId);
    }
    if(!entry) return res.status(404).json({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Unknown isolated lab session'}});
    await entry.transport.handleRequest(req,res,req.body);
  } catch {if(!res.headersSent) res.status(500).json({jsonrpc:'2.0',id:null,error:{code:-32603,message:'Isolated diagnostic transport failed'}});}
});
await new Promise((done,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',done);});
origin=`http://127.0.0.1:${http.address().port}`;
const startedAt=new Date().toISOString();
console.log(JSON.stringify({labUrl:origin,pid:process.pid,waitMs,scope:'loopback-only simulated MCP Apps host; no Chat messages, models, workspaces or Goals',evidenceDirectory:evidence}));
const lifetime=setTimeout(()=>void close(),20*60_000);
async function close(){
  if(closed)return;closed=true;clearTimeout(lifetime);probe.close();
  await writeFile(join(evidence,'result.json'),JSON.stringify({scope:'simulated_mcp_apps_host_not_chatgpt',startedAt,endedAt:new Date().toISOString(),observations,probes:probe.snapshot(),hostedChatAcceptance:'NOT_RUN',quota:'UNVERIFIED'},null,2),{flag:'wx'});
  await Promise.allSettled([...sessions.values()].map(e=>e.server.close()));
  http.closeAllConnections();await new Promise(done=>http.close(done));
  console.log(JSON.stringify({labClosed:true,evidence:join(evidence,'result.json')}));
}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());

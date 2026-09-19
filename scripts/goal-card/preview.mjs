import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
assert.equal(resolve(root).toLowerCase(),resolve('D:/DevSpace-Goal-PoC/.poc/replan-v1/devspace').toLowerCase());
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('tsx/package.json'))('esbuild');
const compiled=await build({entryPoints:[join(root,'scripts/goal-card/preview.ts')],write:false,bundle:true,format:'esm',platform:'browser',logLevel:'warning'});
const card=await readFile(join(root,'dist/chat-goal-decision.html'));
let origin;
const server=createServer((req,res)=>{
  if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return;}
  const path=new URL(req.url,origin).pathname;
  res.setHeader('Cache-Control','no-store');
  if(path==='/card.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(card);}
  else if(path==='/preview.js'){res.setHeader('Content-Type','text/javascript');res.end(compiled.outputFiles[0].text);}
  else if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>Local Goal Card Visual Fixture</title><body style="font:16px system-ui;margin:24px;background:#e3e9f1"><p id="summary">LOCAL VISUAL FIXTURE — 不是 ChatGPT，不创建目标或使用凭据</p><iframe title="目标决策卡片预览" sandbox="allow-scripts" style="width:760px;height:720px;border:0"></iframe><script type="module" src="/preview.js"></script>');}
  else if(path==='/favicon.ico')res.writeHead(204).end();
  else res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({previewUrl:origin,pid:process.pid,scope:'local visual fixture only; no real Goal/MCP credentials/Chat calls'}));
const close=()=>{server.closeAllConnections();server.close();};setTimeout(close,10*60_000).unref();process.once('SIGINT',close);process.once('SIGTERM',close);

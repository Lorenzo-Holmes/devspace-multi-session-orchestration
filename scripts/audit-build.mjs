import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const cwd=process.cwd();
const auditId=process.argv[2];
if(!/^build-[a-z0-9-]+$/.test(auditId??''))throw new Error('Unique build- evidence identifier required.');
const evidence=join('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence',auditId);
if(existsSync(evidence))throw new Error('Refusing to overwrite existing audit evidence.');
mkdirSync(evidence,{recursive:true});
const temp=join(evidence,'temp');mkdirSync(temp,{recursive:true});
const env={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,GIT_CEILING_DIRECTORIES:temp,PATH:'D:/DevSpace/node-v24.20.0-win-x64;'+process.env.PATH};
const steps=[];
function run(label,args){
 const startedAt=new Date().toISOString();
 const r=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:1200000,maxBuffer:32*1024*1024});
 writeFileSync(join(evidence,label+'.log'),(r.stdout??'')+'\n'+(r.stderr??''));
 const item={label,startedAt,endedAt:new Date().toISOString(),status:r.status,error:r.error?.message,tail:((r.stdout??'')+'\n'+(r.stderr??'')).slice(-4000)};
 steps.push(item);console.log(JSON.stringify(item));
}
run('typecheck',['node_modules/typescript/bin/tsc','-p','tsconfig.json','--noEmit']);
run('full-tests',['--import','tsx','--test','--test-concurrency=1','src/**/*.test.ts']);
run('production-build',['scripts/build-production.mjs']);
const versions=Object.fromEntries(['@modelcontextprotocol/sdk','typescript','tsx','vite','better-sqlite3'].map(name=>[name,JSON.parse(readFileSync(join(cwd,'node_modules',name,'package.json'),'utf8')).version]));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest={at:new Date().toISOString(),node:process.version,versions,lockfileHash:sha(join(cwd,'pnpm-lock.yaml')),steps};
writeFileSync(join(evidence,'result.json'),JSON.stringify(manifest,null,2));
process.exitCode=steps.every(s=>s.status===0)?0:1;

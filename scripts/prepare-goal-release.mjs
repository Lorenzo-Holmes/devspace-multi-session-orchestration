import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,cpSync,copyFileSync,existsSync,symlinkSync,readdirSync,statSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const source='D:/DevSpace/devspace',build='D:/DevSpace-Goal-PoC/.poc/replan-v1/devspace';
const base='D:/DevSpace-Goal-PoC/.poc/replan-v1/releases';
const name=process.argv[2];if(!/^web-goal-[a-z0-9-]+$/.test(name??''))throw new Error('Unique web-goal release name required.');
const auditName=process.argv[3];if(!/^build-[a-z0-9-]+$/.test(auditName??''))throw new Error('Passing build audit identifier required.');
const release=join(base,name),previous=join(base,name+'-previous');
for(const p of [release,previous]) {
  const rel=relative(resolve(base),resolve(p));if(!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(p))throw new Error('Unsafe or existing release target.');
}
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const baseline=JSON.parse(readFileSync('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/m0-baseline/baseline.json','utf8'));
if(baseline.files.some(f=>!existsSync(join(source,f.path))||hash(join(source,f.path))!==f.sha256))throw new Error('Source baseline changed; reconcile before deployment.');
const audit=JSON.parse(readFileSync(join('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence',auditName,'result.json'),'utf8'));
if(!audit.steps.every(s=>s.status===0))throw new Error('Final build audit did not pass.');
const git=(...args)=>execFileSync('git',['-C',build,...args],{encoding:'utf8',windowsHide:true}).trim();
if(git('status','--porcelain'))throw new Error('Commit the isolated release source first.');
const pointerPath=join(source,'.devspace-release.json');
const activePointer=existsSync(pointerPath)?JSON.parse(readFileSync(pointerPath,'utf8')):undefined;
const activeBuild=activePointer?resolve(activePointer.entryPoint,'../..'):source;
if(activePointer){const rel=relative(resolve(base),activeBuild);if(!rel||rel.startsWith('..')||isAbsolute(rel)||!existsSync(join(activeBuild,'RELEASE.json')))throw new Error('Unexpected active release location.');}
for(const [dest,src] of [[release,build],[previous,activeBuild]]) {
  mkdirSync(dest,{recursive:true});
  cpSync(join(src,'dist'),join(dest,'dist'),{recursive:true,errorOnExist:true,force:false});
  copyFileSync(join(src,'package.json'),join(dest,'package.json'));
  symlinkSync(join(source,'node_modules'),join(dest,'node_modules'),'junction');
}
copyFileSync(join(source,'start-devspace.ps1'),join(previous,'start-devspace.ps1'));
copyFileSync(join(source,'.devspace-config/config.jsonc'),join(previous,'config.jsonc'));
if(activePointer)copyFileSync(pointerPath,join(previous,'.devspace-release.json'));
const files=[];
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile())files.push({path:relative(release,p),sha256:hash(p),bytes:statSync(p).size});else throw new Error('Unexpected build alias');}}
walk(join(release,'dist'));
const manifest={createdAt:new Date().toISOString(),sourceCommit:git('rev-parse','HEAD'),auditName,release,previous,previousBuild:activeBuild,files,
  originalConfigHash:hash(join(previous,'config.jsonc')),originalStarterHash:hash(join(previous,'start-devspace.ps1')),
  credentialsCopied:false,tunnelChanged:false};
writeFileSync(join(release,'RELEASE.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({release,previous,sourceCommit:manifest.sourceCommit,files:files.length,credentialsCopied:false}));

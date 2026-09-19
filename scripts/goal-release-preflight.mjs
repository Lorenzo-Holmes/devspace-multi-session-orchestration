import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {parse} from 'jsonc-parser';
import {LocalAgentClient} from '../dist/local-agent-client.js';
const source='D:/DevSpace/devspace';
const baseline=JSON.parse(readFileSync('D:/DevSpace-Goal-PoC/.poc/replan-v1/evidence/m0-baseline/baseline.json','utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const changed=baseline.files.filter(f=>!existsSync(join(source,f.path))||hash(join(source,f.path))!==f.sha256).map(f=>f.path);
const configPath=join(source,'.devspace-config/config.jsonc');
const config=parse(readFileSync(configPath,'utf8'));
const root='D:/DevSpace-Goal-PoC/user-acceptance';
const same=(a,b)=>a.toLowerCase().replaceAll('\\','/')===b.toLowerCase().replaceAll('\\','/');
const client=new LocalAgentClient({stateDir:config.storage.stateDir,configDir:join(source,'.devspace-config')});
const daemon=await client.status();
console.log(JSON.stringify({sourceFilesChanged:changed,configHash:hash(configPath),
  configPrefix:readFileSync(configPath,'utf8').split(/\r?\n/).slice(0,8),
  stateDir:config.storage.stateDir,approvedExactProject:config.workspaces.allowedRoots.some(p=>same(p,root)),
  goalsConfigured:!!config.goals,hasReleaseManifest:existsSync(join(source,'.devspace-release.json')),
  daemon:daemon.isOk()?daemon.value:{code:daemon.error.code},oldShrimpUnchanged:hash(baseline.oldState)===baseline.oldStateHash}));

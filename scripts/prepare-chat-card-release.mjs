import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
assert.equal(resolve(root).toLowerCase(),resolve('D:/DevSpace-Goal-PoC/.poc/replan-v1/devspace').toLowerCase());
const buildId=process.argv[2];
assert.match(buildId ?? '',/^chat-goal-card-preview-\d{8}-\d{2}$/);
const releases=resolve(root,'../releases'), destination=join(releases,buildId);
assert.equal(relative(releases,destination),buildId);
const dependencies=await realpath(join(root,'node_modules'));
const card=await readFile(join(root,'dist/chat-card-probe.html'));
assert.ok(card.toString('utf8').includes('卡片通道诊断'));
assert.ok(!card.toString('utf8').includes('<!--CARD_SCRIPT-->'));
const files=[];
async function enumerate(base,dir='') {
  for(const entry of await readdir(join(base,dir),{withFileTypes:true})) {
    const path=join(dir,entry.name);
    assert.ok(!(await lstat(join(base,path))).isSymbolicLink(),'Do not follow source links into a release');
    if(entry.isDirectory()) await enumerate(base,path);
    else if(entry.isFile()) files.push(path);
    else throw new Error('Unsupported release entry');
  }
}
for(const dir of ['dist','bin','schema','skills']) await enumerate(root,dir);
files.push('package.json');
// Exclusive new directory only. Never overwrite another candidate or current release.
await mkdir(destination);
for(const dir of ['dist','bin','schema','skills']) await cp(join(root,dir),join(destination,dir),{recursive:true,force:false,errorOnExist:true});
await cp(join(root,'package.json'),join(destination,'package.json'),{force:false,errorOnExist:true});
await symlink(dependencies,join(destination,'node_modules'),'junction');
const hashes={};
for(const path of files.sort()) {
  const source=await readFile(join(root,path)), copied=await readFile(join(destination,path));
  assert.deepEqual(copied,source);
  hashes[path.replaceAll('\\','/')]=createHash('sha256').update(copied).digest('hex');
}
const manifest={buildId,preparedAt:new Date().toISOString(),state:'PREPARED_NOT_DEPLOYED',entryPoint:join(destination,'dist/cli.js'),
  requiredNodeMajor:24,dependencyMode:'existing shared dependencies; no install or rebuild',dependencies,
  diagnosticConfig:{diagnostics:{chatCard:true}},defaultEnabled:false,productionConfigChanged:false,
  productionRestarted:false,hostedChatAcceptance:'NOT_RUN',quota:'UNVERIFIED',files:hashes};
const serverSource=await readFile(join(destination,'dist/server.js'),'utf8');
manifest.toolSchemaVersion=serverSource.match(/DEVSPACE_TOOL_SCHEMA_VERSION\s*=\s*"([^"]+)"/)?.[1];
manifest.serverVersion=serverSource.match(/DEVSPACE_MCP_SERVER_VERSION\s*=\s*"([^"]+)"/)?.[1];
assert.ok(manifest.toolSchemaVersion&&manifest.serverVersion,'Built runtime identity must be present');
if(hashes['dist/orchestration-v2-tools.js']){
  const {ORCHESTRATION_V2_TOOLS}=await import(new URL('../dist/orchestration-v2-tools.js',import.meta.url));
  manifest.orchestrationV2Tools=ORCHESTRATION_V2_TOOLS;
  manifest.databaseMigrationVersion=18;
  assert.ok(hashes['dist/supervisor.html']);
}
await writeFile(join(destination,'release-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({prepared:destination,files:files.length,productionChanged:false,manifest:join(destination,'release-manifest.json')}));

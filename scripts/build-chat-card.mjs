import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const { build }=createRequire(require.resolve('tsx/package.json'))('esbuild');
const compiled=await build({entryPoints:[join(root,'scripts/card-lab/card.ts')],write:false,
  bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,logLevel:'warning'});
assert.equal(compiled.outputFiles.length,1);
const script=compiled.outputFiles[0].text.replaceAll('</script','<\\/script');
const template=await readFile(join(root,'scripts/card-lab/card.html'),'utf8');
assert.equal(template.split('<!--CARD_SCRIPT-->').length,2);
const html=template.replace('<!--CARD_SCRIPT-->',()=>`<script>${script}</script>`);
assert.ok(html.includes(script));
assert.ok(!html.includes('<!--CARD_SCRIPT-->'));
await mkdir(resolve(root,'dist'),{recursive:true});
await writeFile(join(root,'dist/chat-card-probe.html'),html);
console.log('Packaged self-contained diagnostic card; no external assets or credentials embedded.');
const goalCompiled=await build({entryPoints:[join(root,'scripts/goal-card/card.ts')],write:false,
  bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,logLevel:'warning'});
assert.equal(goalCompiled.outputFiles.length,1);
const goalScript=goalCompiled.outputFiles[0].text.replaceAll('</script','<\\/script');
const goalTemplate=await readFile(join(root,'scripts/goal-card/card.html'),'utf8');
assert.equal(goalTemplate.split('<!--CARD_SCRIPT-->').length,2);
await writeFile(join(root,'dist/chat-goal-decision.html'),goalTemplate.replace('<!--CARD_SCRIPT-->',()=>`<script>${goalScript}</script>`));
console.log('Packaged self-contained Goal decision card; no model calls or external assets.');
const computerCompiled=await build({entryPoints:[join(root,'scripts/computer-approval/card.ts')],write:false,
  bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,logLevel:'warning'});
assert.equal(computerCompiled.outputFiles.length,1);
const computerScript=computerCompiled.outputFiles[0].text.replaceAll('</script','<\\/script');
const computerTemplate=await readFile(join(root,'scripts/computer-approval/card.html'),'utf8');
assert.equal(computerTemplate.split('<!--CARD_SCRIPT-->').length,2);
await writeFile(join(root,'dist/computer-use-approval.html'),computerTemplate.replace('<!--CARD_SCRIPT-->',()=>`<script>${computerScript}</script>`));
console.log('Packaged self-contained Computer Use approval card; no automatic approval or model calls.');
const supervisorCompiled=await build({entryPoints:[join(root,'scripts/supervisor/card.ts')],write:false,
  bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,logLevel:'warning'});
assert.equal(supervisorCompiled.outputFiles.length,1);
const supervisorScript=supervisorCompiled.outputFiles[0].text.replaceAll('</script','<\\/script');
const supervisorTemplate=await readFile(join(root,'scripts/supervisor/card.html'),'utf8');
assert.equal(supervisorTemplate.split('<!--CARD_SCRIPT-->').length,2);
await writeFile(join(root,'dist/supervisor.html'),supervisorTemplate.replace('<!--CARD_SCRIPT-->',()=>`<script>${supervisorScript}</script>`));
console.log('Packaged read-only Supervisor card; no action tools or background calls.');

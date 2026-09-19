import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root=fileURLToPath(new URL('.',import.meta.url));
// Reuse the already installed tsx dependency, without changing shared packages.
// The first Vite IIFE build emitted an undefined init_locales reference; the
// real browser caught it. Production's existing build is not changed here.
const require=createRequire(import.meta.url);
const build=createRequire(require.resolve('tsx/package.json'))('esbuild').build;
for(const entry of ['card','host']) await build({
  entryPoints:[resolve(root,`${entry}.ts`)],outfile:resolve(root,`../../.card-lab-build/${entry}.js`),
  bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,logLevel:'warning'});
console.log('Isolated card lab bundles built; production UI untouched.');

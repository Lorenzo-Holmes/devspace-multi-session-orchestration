import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
let status = 'FAIL', reason;
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major >= 27 || (major === 22 && minor < 19)) {
    status = 'ENVIRONMENT_SKIP'; throw new Error('Runtime is outside package engines >=22.19 <27');
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.scripts?.build !== 'pnpm clean && pnpm build:app && pnpm build:chat-card && tsc -p tsconfig.build.json') {
    throw new Error('Canonical package build changed; review clean/app/card/TypeScript contract');
  }
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const version = spawnSync(command, ['--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 15000 });
  if (version.error || version.status !== 0) { status = 'ENVIRONMENT_SKIP'; throw new Error('pnpm is unavailable'); }
  if ('pnpm@' + version.stdout.trim() !== pkg.packageManager) throw new Error('pnpm does not match packageManager');
  await mkdir(join(root, 'dist'), { recursive: true });
  const staleMarker = join(root, 'dist', '.stale-build-probe-' + randomUUID());
  await writeFile(staleMarker, 'This must be removed by the canonical clean step.\n', { flag: 'wx' });
  const built = spawnSync(command, ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', timeout: 900000 });
  if (built.error || built.status !== 0) throw new Error('Canonical pnpm build failed: ' + (built.error?.code ?? built.status));
  const stale = await stat(staleMarker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (stale) throw new Error('Clean contract failed: stale dist marker survived');
  for (const path of ['dist/server.js', 'dist/cli.js', 'dist/supervisor.html', 'dist/chat-card-probe.html']) {
    if (!(await stat(join(root, path))).isFile()) throw new Error('Required build output is missing: ' + path);
  }
  status = 'PASS';
} catch (error) { reason = error.message; }
console.log(JSON.stringify({ stage: 'production-build', status, reason, startedAt,
  endedAt: new Date().toISOString(), node: process.version, platform: process.platform, nativeABI: process.versions.modules }));
process.exitCode = status === 'PASS' ? 0 : status === 'ENVIRONMENT_SKIP' ? 2 : 1;

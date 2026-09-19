import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = async name => readFile(new URL(name, import.meta.url), 'utf8');

test('legacy packaged acceptance imports Utility before hashing', async () => {
  const script = await source('test-chat-card-release.ps1');
  assert.match(script, /Import-Module Microsoft\.PowerShell\.Utility -ErrorAction Stop/);
  assert.ok(script.indexOf('Import-Module Microsoft.PowerShell.Utility') < script.indexOf('(Get-FileHash'));
});
test('audit build delegates the single package build path', async () => {
  const script = await source('audit-build.mjs');
  assert.match(script, /run\('production-build',\['scripts\/build-production\.mjs'\]\)/);
  assert.doesNotMatch(script, /run\('(?:ui-build|server-build)'/);
});
test('canonical build wrapper requires clean marker removal and mandatory outputs', async () => {
  const script = await source('build-production.mjs');
  assert.match(script, /spawnSync\(command, \['build'\]/);
  assert.match(script, /if \(stale\) throw new Error/);
  for (const name of ['dist/server.js', 'dist/cli.js', 'dist/supervisor.html', 'dist/chat-card-probe.html']) assert.ok(script.includes(name));
});
test('PowerShell preflight disables autoload after explicit module imports', async () => {
  const script = await source('test-release-preflight.ps1');
  assert.match(script, /\$PSModuleAutoLoadingPreference = 'None'/);
  assert.match(script, /Parser\]::ParseFile/);
  assert.match(script, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
  assert.match(script, /finally/);
});
test('release CLI invalid usage fails with a structured result', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr.trim()).status, 'FAIL');
});
for (const shell of ['powershell.exe', 'pwsh.exe']) test('no-profile Windows parser/hash preflight: ' + shell, { timeout: 30000 }, t => {
  if (process.platform !== 'win32') return t.skip('PLATFORM_SKIP: Windows PowerShell 5.1/7 execution requires Windows');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', 'scripts/test-release-preflight.ps1', '-RepositoryRoot', root],
    { cwd: root, env, encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error?.code === 'ENOENT') return t.skip('ENVIRONMENT_SKIP: ' + shell + ' is not installed');
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).status, 'PASS');
});

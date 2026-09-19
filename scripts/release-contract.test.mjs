import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, toolCatalogFingerprints, portablePath, inventory, sealRelease,
  verifyRelease, snapshotRollback, verifyRollback, REQUIRED_RUNTIME, INTEGRITY_FILE } from './release-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const tools = [
  { name: 'session_list', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } }, annotations: { readOnlyHint: true } },
  { name: 'supervisor_summary', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app', 'model'] } } },
  { name: 'app_only', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false }, _meta: { ui: { visibility: ['app'] } } },
];
async function put(root, path, bytes) {
  const full = join(root, path); await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, bytes);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'devspace release fixture '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, 'candidate path with spaces'), deps = join(root, 'shared deps');
  await mkdir(release); await mkdir(deps);
  for (const path of REQUIRED_RUNTIME) await put(release, path, path + '\n');
  await put(release, 'package.json', '{"name":"isolated-release-fixture"}\n');
  await put(release, 'dist/server.js', 'export const DEVSPACE_TOOL_SCHEMA_VERSION = "fixture-schema";\nexport const DEVSPACE_MCP_SERVER_VERSION = "fixture-version";\n');
  await put(deps, 'better-sqlite3/package.json', '{"version":"0.0.0-fixture"}');
  await put(deps, '@modelcontextprotocol/sdk/package.json', '{"version":"0.0.0-fixture"}');
  await put(deps, 'better-sqlite3/build/Release/better_sqlite3.node', 'NOT A REAL NATIVE MODULE: identity fixture only');
  await symlink(deps, join(release, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const metadata = { buildId: 'candidate', sourceCommit: 'a'.repeat(40), dirtyTree: false,
    requiredNodeMajor: Number(process.versions.node.split('.')[0]), pnpmVersion: '11.25.0',
    toolSchemaVersion: 'fixture-schema', serverVersion: 'fixture-version', databaseMigrationVersion: 18 };
  const sealed = await sealRelease(release, metadata, tools);
  return { root, release, deps, metadata, ...sealed };
}
async function editManifest(f, mutate) {
  const value = JSON.parse(await readFile(join(f.release, INTEGRITY_FILE), 'utf8'));
  mutate(value);
  const bytes = JSON.stringify(value);
  await writeFile(join(f.release, INTEGRITY_FILE), bytes);
  // A fresh trusted hash deliberately exercises internal validation, not just digest mismatch.
  return sha(bytes);
}
function pointer(f) {
  return { buildId: f.manifest.buildId, entryPoint: join(f.release, 'dist/cli.js'),
    serverSha256: f.manifest.files.find(file => file.path === 'dist/server.js').sha256 };
}
async function pair(t) {
  const candidate = await fixture(t), rollback = join(candidate.root, 'rollback');
  await cp(candidate.release, rollback, { recursive: true, verbatimSymlinks: true });
  await rm(join(rollback, INTEGRITY_FILE));
  const old = await sealRelease(rollback, { ...candidate.metadata, buildId: 'rollback' }, tools);
  const rollbackFixture = { ...old, release: rollback };
  const context = { databaseMigrationVersion: 18, protectedHashes: { config: sha('fixture config') }, pointer: pointer(rollbackFixture) };
  const snapshot = await snapshotRollback({ root: candidate.release, sha256: candidate.manifestSha256 },
    { root: rollback, sha256: old.manifestSha256 }, context);
  return { candidate, rollback, old, context, snapshot, after: { ...context, pointer: pointer(candidate) } };
}

test('canonical JSON is deterministic and rejects non-JSON inputs', () => {
  assert.equal(canonicalJson({ z: 1, a: { b: 2, a: 3 } }), canonicalJson({ a: { a: 3, b: 2 }, z: 1 }));
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, NaN, Infinity, undefined, { x: undefined }, new Date(), Array(2)]) assert.throws(() => canonicalJson(value));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});
test('catalog order, object key order and visibility set order do not change fingerprints', () => {
  const reordered = structuredClone(tools).reverse();
  reordered.find(tool => tool.name === 'supervisor_summary')._meta.ui.visibility.reverse();
  reordered.find(tool => tool.name === 'session_list').inputSchema = { properties: { limit: { type: 'integer' } }, type: 'object' };
  assert.deepEqual(toolCatalogFingerprints(tools), toolCatalogFingerprints(reordered));
  assert.equal(toolCatalogFingerprints(tools).toolCatalogNameFingerprint, sha(tools.map(tool => tool.name).sort().join('\n')));
});
for (const [label, mutate] of [
  ['input schema', tool => { tool.inputSchema.properties.limit.minimum = 1; }],
  ['output schema', tool => { tool.outputSchema = { type: 'string' }; }],
  ['read-only annotation', tool => { tool.annotations.readOnlyHint = false; }],
  ['mutation annotation', tool => { tool.annotations.destructiveHint = true; }],
  ['visibility', tool => { tool._meta = { ui: { visibility: ['app'] } }; }],
  ['other metadata', tool => { tool._meta = { audit: 'changed' }; }],
]) test('definition fingerprint detects same-name change: ' + label, () => {
  const changed = structuredClone(tools); mutate(changed[0]);
  const before = toolCatalogFingerprints(tools), after = toolCatalogFingerprints(changed);
  assert.equal(before.toolCatalogNameFingerprint, after.toolCatalogNameFingerprint);
  assert.notEqual(before.toolCatalogDefinitionFingerprint, after.toolCatalogDefinitionFingerprint);
});
test('duplicate names and invalid visibility fail closed', () => {
  assert.throws(() => toolCatalogFingerprints([...tools, tools[0]]));
  assert.throws(() => toolCatalogFingerprints([{ name: 'bad\nname', inputSchema: {} }]));
  assert.throws(() => toolCatalogFingerprints([{ name: 'bad', inputSchema: {}, _meta: { ui: { visibility: ['unknown'] } } }]));
});
for (const path of ['../escape', '/absolute', 'C:/outside', 'C:\\outside', '\\\\server\\share', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a:stream', 'nul.txt', 'a/COM1', 'trailing.', 'trailing ', '', 'a\u0000b']) {
  test('reject unsafe portable path ' + JSON.stringify(path), () => assert.throws(() => portablePath(path)));
}
test('valid relative paths can contain spaces', () => assert.equal(portablePath('dist/path with spaces/file.js'), 'dist/path with spaces/file.js'));
test('valid release verifies and cannot be resealed in place', async t => {
  const f = await fixture(t);
  assert.equal((await verifyRelease(f.release, f.manifestSha256)).status, 'PASS');
  await assert.rejects(sealRelease(f.release, f.metadata, tools), /EEXIST/);
});
for (const [label, mutate] of [
  ['modified runtime file', async f => put(f.release, 'dist/server.js', 'changed')],
  ['missing entrypoint', async f => rm(join(f.release, 'dist/cli.js'))],
  ['missing required runtime', async f => rm(join(f.release, 'dist/orchestration-v2-tools.js'))],
  ['extra runtime file', async f => put(f.release, 'dist/unexpected.js', 'extra')],
  ['extra root runtime file', async f => put(f.release, 'unexpected.mjs', 'extra')],
  ['lockfile changed', async f => put(f.release, 'pnpm-lock.yaml', 'changed')],
  ['package changed', async f => put(f.release, 'package.json', '{}')],
  ['native binary changed', async f => put(f.deps, 'better-sqlite3/build/Release/better_sqlite3.node', 'changed')],
  ['dependency package changed', async f => put(f.deps, 'better-sqlite3/package.json', '{"version":"9.9.9"}')],
  ['dependency file added', async f => put(f.deps, 'injected.js', 'unexpected')],
  ['manifest modified', async f => put(f.release, INTEGRITY_FILE, '{}')],
  ['manifest corrupt', async f => put(f.release, INTEGRITY_FILE, '{')],
]) test('artifact fault fails closed: ' + label, async t => {
  const f = await fixture(t); await mutate(f);
  await assert.rejects(verifyRelease(f.release, f.manifestSha256));
});
for (const [label, mutate] of [
  ['unsupported schema', m => { m.schemaVersion = 999; }],
  ['duplicate path', m => { m.files.push(m.files[0]); }],
  ['escaping path', m => { m.files[0].path = '../outside'; }],
  ['wrong file hash', m => { m.files.find(f => f.path === 'dist/cli.js').sha256 = '0'.repeat(64); }],
  ['wrong byte size', m => { m.files[0].bytes += 1; }],
  ['wrong Node major', m => { m.runtime.nodeMajor += 1; }],
  ['wrong ABI', m => { m.runtime.nativeABI = 'invalid'; }],
  ['wrong architecture', m => { m.runtime.arch = 'other'; }],
  ['wrong platform', m => { m.runtime.platform = 'other'; }],
  ['inconsistent Node version', m => { m.runtime.nodeVersion = 'v1.0.0'; }],
  ['wrong lock hash', m => { m.lockfileHash = '0'.repeat(64); }],
  ['wrong package hash', m => { m.packageJsonHash = '0'.repeat(64); }],
  ['wrong dependency root', m => { m.dependencies.root += '-other'; }],
  ['wrong dependency fingerprint', m => { m.dependencies.treeFingerprint = '0'.repeat(64); }],
  ['wrong server identity', m => { m.serverVersion = 'other'; }],
  ['wrong schema identity', m => { m.toolSchemaVersion = 'other'; }],
  ['wrong catalog fingerprint', m => { m.catalogFingerprints.toolCatalogDefinitionFingerprint = '0'.repeat(64); }],
  ['changed catalog definition', m => { m.toolCatalog[0].annotations.readOnlyHint = false; }],
  ['missing entrypoint metadata', m => { delete m.entryPoint; }],
  ['unknown migration compatibility', m => { m.databaseMigrationVersion = null; }],
  ['dirty source', m => { m.dirtyTree = true; }],
]) test('manifest self-consistency fault fails closed: ' + label, async t => {
  const f = await fixture(t), trusted = await editManifest(f, mutate);
  await assert.rejects(verifyRelease(f.release, trusted));
});
test('independent manifest hash is mandatory and wrong hash fails', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyRelease(f.release));
  await assert.rejects(verifyRelease(f.release, '0'.repeat(64)));
});
test('CRLF changes are detected rather than normalized away', async t => {
  const f = await fixture(t), file = join(f.release, 'dist/server.js');
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\n', '\r\n'));
  await assert.rejects(verifyRelease(f.release, f.manifestSha256));
});
test('artifact junctions and dependency links escaping their root are rejected', async t => {
  const f = await fixture(t);
  await symlink(f.deps, join(f.release, 'dist', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inventory(f.release), /symlink|junction/);
  await rm(join(f.release, 'dist', 'linked'));
  await symlink(f.release, join(f.deps, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inventory(f.deps, { dependency: true }), /escapes/);
});
test('internal dependency links are inventoried without following cycles', async t => {
  const f = await fixture(t);
  await symlink(f.deps, join(f.deps, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  const records = await inventory(f.deps, { dependency: true });
  assert.ok(records.some(record => record.kind === 'link' && record.path === 'cycle'));
});
test('inventory limit is enforced', async t => {
  const f = await fixture(t); await assert.rejects(inventory(f.release, { maxEntries: 1 }), /limit/);
});
test('rollback readiness fixture verifies without performing a rollback', async t => {
  const p = await pair(t); assert.equal((await verifyRollback(p.snapshot, p.after)).status, 'PASS');
});
test('rollback artifact modified after snapshot is rejected', async t => {
  const p = await pair(t); await put(p.rollback, 'dist/cli.js', 'changed');
  await assert.rejects(verifyRollback(p.snapshot, p.after));
});
for (const [label, mutate] of [
  ['candidate pointer mismatch', context => { context.pointer.buildId = 'wrong'; }],
  ['pointer entrypoint mismatch', context => { context.pointer.entryPoint += '.other'; }],
  ['pointer server hash mismatch', context => { context.pointer.serverSha256 = '0'.repeat(64); }],
  ['protected configuration changed', context => { context.protectedHashes.config = sha('changed'); }],
  ['migration changed', context => { context.databaseMigrationVersion += 1; }],
]) test('rollback postflight rejects ' + label, async t => {
  const p = await pair(t); mutate(p.after); await assert.rejects(verifyRollback(p.snapshot, p.after));
});
test('rollback preflight rejects unknown cross-migration compatibility', async t => {
  const p = await pair(t); p.context.databaseMigrationVersion += 1;
  await assert.rejects(snapshotRollback(p.snapshot.candidateSpec, p.snapshot.rollbackSpec, p.context));
});

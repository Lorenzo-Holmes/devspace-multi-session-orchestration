import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const INTEGRITY_FILE = 'release-integrity.json';
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const REQUIRED_RUNTIME = Object.freeze([
  'package.json', 'pnpm-lock.yaml', 'dist/cli.js', 'dist/server.js',
  'dist/orchestration-v2-tools.js', 'dist/supervisor.html',
]);
const digest = value => createHash('sha256').update(value).digest('hex');
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Structural JSON canonicalization. Object order is irrelevant; schema array order is retained.
export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') { assert.ok(Number.isFinite(item), 'Non-finite JSON number'); return JSON.stringify(item); }
    assert.ok(item && typeof item === 'object', 'Non-JSON value');
    assert.ok(!ancestors.has(item), 'Cyclic JSON');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      assert.equal(Object.keys(item).length, item.length, 'Sparse or decorated JSON array');
      result = '[' + item.map(encode).join(',') + ']';
    } else {
      assert.ok(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'Non-plain JSON object');
      result = '{' + Object.keys(item).sort(cmp).map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

export function toolCatalogFingerprints(tools) {
  assert.ok(Array.isArray(tools) && tools.length > 0, 'Complete nonempty catalog required');
  const names = new Set();
  const definitions = tools.map(tool => {
    assert.ok(tool && typeof tool.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(tool.name), 'Invalid tool name');
    assert.ok(!names.has(tool.name), 'Duplicate tool name'); names.add(tool.name);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema), 'Missing input schema');
    const meta = JSON.parse(canonicalJson(tool._meta ?? {}));
    const visibility = meta.ui?.visibility;
    if (visibility !== undefined) {
      assert.ok(Array.isArray(visibility) && visibility.every(v => v === 'app' || v === 'model'), 'Invalid tool visibility');
      meta.ui.visibility = [...new Set(visibility)].sort(cmp);
    }
    return { name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? {}, _meta: meta };
  }).sort((a, b) => cmp(a.name, b.name));
  return {
    toolCatalogNameFingerprint: digest([...names].sort(cmp).join('\n')),
    toolCatalogDefinitionFingerprint: digest(canonicalJson(definitions)),
  };
}

export function portablePath(name) {
  assert.ok(typeof name === 'string' && name.length > 0 && !/[\\:\x00-\x1f\x7f*?"<>|]/.test(name), 'Unsafe artifact path');
  assert.ok(!isAbsolute(name), 'Absolute artifact path');
  for (const part of name.split('/')) {
    assert.ok(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'Unsafe path segment');
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), 'Windows reserved path');
  }
  return name;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
}
async function fileDigest(path) {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Expected regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  assert.ok(after.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'File changed during hashing');
  return { bytes: after.size, sha256: hash.digest('hex') };
}

// Links in dependencies are recorded, never recursively followed, and cannot escape the root.
export async function inventory(root, { dependency = false, maxEntries = 1_000_000 } = {}) {
  root = await realpath(root);
  const entries = [], seen = new Set();
  async function walk(dir = '') {
    for (const entry of (await readdir(join(root, dir), { withFileTypes: true })).sort((a, b) => cmp(a.name, b.name))) {
      const name = portablePath(dir ? dir + '/' + entry.name : entry.name);
      if (!dependency && !dir && (name === INTEGRITY_FILE || name === 'node_modules')) continue;
      assert.ok(!seen.has(name.toLowerCase()), 'Case-colliding artifact path'); seen.add(name.toLowerCase());
      assert.ok(seen.size <= maxEntries, 'Inventory entry limit exceeded');
      const full = join(root, name), stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        assert.ok(dependency, 'Artifact symlink or junction is forbidden');
        const target = await realpath(full);
        assert.ok(inside(root, target), 'Dependency link escapes its root');
        entries.push({ path: name, kind: 'link', target: relative(root, target).replaceAll('\\', '/') });
      } else if (stat.isDirectory()) await walk(name);
      else { assert.ok(stat.isFile(), 'Unsupported filesystem entry'); entries.push({ path: name, kind: 'file', ...await fileDigest(full) }); }
    }
  }
  await walk();
  return entries.sort((a, b) => cmp(a.path, b.path));
}

export async function dependencyIdentity(root) {
  const resolvedRoot = await realpath(root), files = await inventory(resolvedRoot, { dependency: true });
  const criticalPackageVersions = {};
  for (const name of ['better-sqlite3', '@modelcontextprotocol/sdk']) {
    const pkg = JSON.parse(await readFile(join(resolvedRoot, name, 'package.json'), 'utf8'));
    assert.ok(typeof pkg.version === 'string' && pkg.version.length > 0, 'Missing critical dependency version');
    criticalPackageVersions[name] = pkg.version;
  }
  const nativeBinaries = files.filter(file => file.kind === 'file' && file.path.endsWith('.node'));
  assert.ok(nativeBinaries.some(file => file.path.endsWith('/better_sqlite3.node')), 'SQLite native binary missing');
  return { root: resolvedRoot, treeFingerprint: digest(canonicalJson(files)), fileCount: files.length,
    totalFileBytes: files.reduce((sum, file) => sum + (file.bytes ?? 0), 0), criticalPackageVersions, nativeBinaries };
}
function runtimeIdentity(pnpmVersion) {
  return { nodeVersion: process.version, nodeMajor: Number(process.versions.node.split('.')[0]),
    nativeABI: process.versions.modules, platform: process.platform, arch: process.arch, pnpmVersion };
}
function validateMetadata(manifest, files) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported integrity manifest schema');
  assert.match(manifest.buildId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.match(manifest.sourceCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.equal(manifest.dirtyTree, false, 'Dirty source is not release-ready');
  assert.ok(typeof manifest.builtAt === 'string' && Number.isFinite(Date.parse(manifest.builtAt)), 'Invalid build timestamp');
  assert.ok(Number.isInteger(manifest.databaseMigrationVersion) && manifest.databaseMigrationVersion > 0, 'Unknown migration version');
  assert.ok(typeof manifest.toolSchemaVersion === 'string' && manifest.toolSchemaVersion.length > 0, 'Missing tool schema version');
  assert.ok(typeof manifest.serverVersion === 'string' && manifest.serverVersion.length > 0, 'Missing server version');
  assert.match(manifest.runtime.pnpmVersion, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  assert.equal(manifest.dependencyMode, 'shared-verified-not-immutable');
  assert.equal(manifest.entryPoint, 'dist/cli.js');
  const paths = new Set();
  for (const file of files) {
    portablePath(file.path);
    assert.ok(!paths.has(file.path.toLowerCase()), 'Duplicate artifact path'); paths.add(file.path.toLowerCase());
    assert.equal(file.kind, 'file'); assert.ok(hex(file.sha256), 'Invalid artifact hash');
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'Invalid artifact size');
  }
  for (const name of REQUIRED_RUNTIME) assert.ok(files.some(file => file.path === name), 'Missing runtime artifact: ' + name);
  assert.equal(manifest.packageJsonHash, files.find(file => file.path === 'package.json').sha256, 'Package identity mismatch');
  assert.equal(manifest.lockfileHash, files.find(file => file.path === 'pnpm-lock.yaml').sha256, 'Lock identity mismatch');
  assert.deepEqual(toolCatalogFingerprints(manifest.toolCatalog), manifest.catalogFingerprints, 'Catalog identity mismatch');
}
async function validateServerIdentity(root, manifest) {
  const source = await readFile(join(root, 'dist/server.js'), 'utf8');
  for (const [symbol, field] of [['DEVSPACE_TOOL_SCHEMA_VERSION', 'toolSchemaVersion'], ['DEVSPACE_MCP_SERVER_VERSION', 'serverVersion']]) {
    const found = [...source.matchAll(new RegExp('\\b' + symbol + '\\s*=\\s*["\']([^"\']+)["\']', 'g'))];
    assert.equal(found.length, 1, 'Runtime identity must be unambiguous: ' + symbol);
    assert.equal(found[0][1], manifest[field], 'Runtime identity mismatch: ' + field);
  }
}

// Additive sidecar: the existing release-manifest.json remains unchanged and is itself hashed.
// The caller must supply catalog data observed from the exact candidate, not a name-only list.
export async function sealRelease(root, metadata, tools) {
  assert.ok(!(await lstat(root)).isSymbolicLink(), 'Release root must be a real directory');
  root = await realpath(root);
  const files = await inventory(root);
  const manifest = { schemaVersion: 1, buildId: metadata.buildId, sourceCommit: metadata.sourceCommit,
    dirtyTree: metadata.dirtyTree, builtAt: new Date().toISOString(), entryPoint: 'dist/cli.js',
    runtime: runtimeIdentity(metadata.pnpmVersion), toolSchemaVersion: metadata.toolSchemaVersion,
    serverVersion: metadata.serverVersion, databaseMigrationVersion: metadata.databaseMigrationVersion,
    dependencyMode: 'shared-verified-not-immutable', dependencies: await dependencyIdentity(join(root, 'node_modules')),
    packageJsonHash: files.find(file => file.path === 'package.json')?.sha256,
    lockfileHash: files.find(file => file.path === 'pnpm-lock.yaml')?.sha256,
    toolCatalog: tools, catalogFingerprints: toolCatalogFingerprints(tools), files };
  assert.equal(manifest.runtime.nodeMajor, metadata.requiredNodeMajor, 'Build Node major mismatch');
  validateMetadata(manifest, files); await validateServerIdentity(root, manifest);
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  assert.ok(Buffer.byteLength(bytes) <= MAX_MANIFEST_BYTES, 'Integrity manifest size limit exceeded');
  await writeFile(join(root, INTEGRITY_FILE), bytes, { flag: 'wx' });
  return { manifest, manifestSha256: digest(bytes) };
}

// expectedSha256 must come from a trusted build record, not from this candidate directory.
export async function verifyRelease(root, expectedSha256) {
  assert.ok(hex(expectedSha256), 'Independent trusted manifest SHA-256 required');
  assert.ok(!(await lstat(root)).isSymbolicLink(), 'Release root must be a real directory');
  root = await realpath(root);
  const manifestPath = join(root, INTEGRITY_FILE);
  assert.ok((await lstat(manifestPath)).isFile() && !(await lstat(manifestPath)).isSymbolicLink(), 'Manifest must be a regular file');
  assert.ok((await lstat(manifestPath)).size <= MAX_MANIFEST_BYTES, 'Integrity manifest size limit exceeded');
  const bytes = await readFile(manifestPath);
  assert.ok(bytes.length <= MAX_MANIFEST_BYTES, 'Integrity manifest size limit exceeded');
  assert.equal(digest(bytes), expectedSha256, 'Integrity manifest changed');
  const manifest = JSON.parse(bytes.toString('utf8'));
  validateMetadata(manifest, manifest.files);
  const current = runtimeIdentity(manifest.runtime.pnpmVersion);
  for (const key of ['nodeMajor', 'nativeABI', 'platform', 'arch']) assert.equal(manifest.runtime[key], current[key], 'Runtime mismatch: ' + key);
  assert.equal(Number(manifest.runtime.nodeVersion.replace(/^v/, '').split('.')[0]), manifest.runtime.nodeMajor, 'Inconsistent Node identity');
  const actual = await inventory(root);
  assert.deepEqual(actual, manifest.files, 'Missing, extra, modified or reordered artifact');
  assert.deepEqual(await dependencyIdentity(join(root, 'node_modules')), manifest.dependencies, 'Shared dependency identity changed');
  await validateServerIdentity(root, manifest);
  return { status: 'PASS', root, manifest, manifestSha256: expectedSha256, guarantees: 'point-in-time integrity; not filesystem immutability' };
}
function verifyPointer(pointer, release) {
  assert.equal(pointer.buildId, release.manifest.buildId, 'Production pointer build mismatch');
  assert.equal(resolve(pointer.entryPoint), join(release.root, release.manifest.entryPoint), 'Production pointer entrypoint mismatch');
  assert.equal(pointer.serverSha256, release.manifest.files.find(file => file.path === 'dist/server.js').sha256, 'Production pointer server mismatch');
}
function protectedHashes(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0, 'Protected hashes required');
  for (const hash of Object.values(value)) assert.ok(hex(hash), 'Invalid protected hash');
}
export async function snapshotRollback(candidateSpec, rollbackSpec, context) {
  const candidate = await verifyRelease(candidateSpec.root, candidateSpec.sha256);
  const rollback = await verifyRelease(rollbackSpec.root, rollbackSpec.sha256);
  assert.notEqual(candidate.manifest.buildId, rollback.manifest.buildId);
  assert.notEqual(candidate.root, rollback.root);
  for (const release of [candidate, rollback]) assert.equal(release.manifest.databaseMigrationVersion, context.databaseMigrationVersion, 'Rollback schema compatibility unknown');
  verifyPointer(context.pointer, rollback); protectedHashes(context.protectedHashes);
  return JSON.parse(canonicalJson({ candidateSpec: { root: candidate.root, sha256: candidate.manifestSha256 },
    rollbackSpec: { root: rollback.root, sha256: rollback.manifestSha256 }, context,
    recordedAt: new Date().toISOString(), scope: 'offline artifact readiness; live drain and runtime health not verified' }));
}
export async function verifyRollback(snapshot, context) {
  const candidate = await verifyRelease(snapshot.candidateSpec.root, snapshot.candidateSpec.sha256);
  await verifyRelease(snapshot.rollbackSpec.root, snapshot.rollbackSpec.sha256);
  assert.equal(context.databaseMigrationVersion, snapshot.context.databaseMigrationVersion, 'Database migration changed');
  protectedHashes(context.protectedHashes);
  assert.deepEqual(context.protectedHashes, snapshot.context.protectedHashes, 'Protected configuration changed');
  verifyPointer(context.pointer, candidate);
  return { status: 'PASS', scope: snapshot.scope, destructiveActions: false };
}

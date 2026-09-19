import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { sealRelease, verifyRelease, snapshotRollback, verifyRollback } from './release-contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const [mode, ...args] = process.argv.slice(2);
try {
  let result;
  if (mode === 'seal' && args.length === 3) {
    const [root, metadataPath, catalogPath] = args;
    const catalog = await json(catalogPath);
    const sealed = await sealRelease(root, await json(metadataPath), Array.isArray(catalog) ? catalog : catalog.tools);
    result = { status: 'PASS', scope: 'additive integrity sidecar; not deployment acceptance',
      buildId: sealed.manifest.buildId, manifestSha256: sealed.manifestSha256,
      ...sealed.manifest.catalogFingerprints };
  } else if (mode === 'verify' && args.length === 2) {
    const verified = await verifyRelease(args[0], args[1]);
    result = { status: verified.status, buildId: verified.manifest.buildId,
      fileCount: verified.manifest.files.length, guarantees: verified.guarantees,
      ...verified.manifest.catalogFingerprints };
  } else if (mode === 'snapshot' && args.length === 6) {
    const [candidate, candidateHash, rollback, rollbackHash, contextPath, output] = args;
    const snapshot = await snapshotRollback({ root: candidate, sha256: candidateHash },
      { root: rollback, sha256: rollbackHash }, await json(contextPath));
    const bytes = JSON.stringify(snapshot, null, 2) + '\n';
    await writeFile(output, bytes, { flag: 'wx' });
    result = { status: 'PASS', scope: snapshot.scope, snapshotSha256: hash(bytes) };
  } else if (mode === 'postflight' && args.length === 3) {
    const [snapshotPath, trustedSnapshotHash, contextPath] = args;
    assert.match(trustedSnapshotHash, /^[a-f0-9]{64}$/, 'Independent snapshot hash required');
    const bytes = await readFile(snapshotPath);
    assert.equal(hash(bytes), trustedSnapshotHash, 'Rollback snapshot changed');
    result = await verifyRollback(JSON.parse(bytes.toString('utf8')), await json(contextPath));
  } else {
    throw new Error('Usage: verify-release.mjs seal ROOT METADATA_JSON CATALOG_JSON | verify ROOT TRUSTED_SHA256 | snapshot CANDIDATE SHA ROLLBACK SHA CONTEXT_JSON OUTPUT_JSON | postflight SNAPSHOT_JSON TRUSTED_SHA256 CONTEXT_JSON');
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', operation: mode ?? 'usage', reason: error.message }));
  process.exitCode = 1;
}

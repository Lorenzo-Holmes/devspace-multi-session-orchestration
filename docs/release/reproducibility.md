# Reproducibility and offline integrity contract

## What is implemented

The new `release-integrity.json` sidecar has schema version 1. It is additive:
legacy `release-manifest.json` is not reinterpreted and, when present, is itself
included in the exact artifact inventory. Public MCP runtime fields and tool
schemas are unchanged.

The sidecar records build id, supplied source commit and clean-tree flag,
sealing timestamp, Node version/major/native ABI/platform/architecture, supplied
pnpm version, package and lockfile hashes, server/schema versions, supplied
database migration version, full catalog definitions, artifact hashes/sizes,
and shared dependency identity. The timestamp is when sealing ran, not an
independent attestation of compilation time.

Both fingerprints are retained. The name fingerprint is SHA-256 of sorted
names separated by newline. The definition fingerprint canonicalizes each
name, inputSchema, outputSchema, annotations and _meta, sorts tools and object
keys, and normalizes UI visibility as a set. Other array order is retained.
Same-name changes to schemas, annotations or visibility change the definition
fingerprint; tool order and object key order do not. Descriptions and titles
are outside this definition contract. Capture the complete catalog, including
App-only tools, from the exact candidate and resolve any pagination before
sealing; completeness is a caller responsibility.

Artifacts are sorted, hashed and checked as exact file inventories. Missing,
extra or modified files, duplicate/case-colliding names, unsafe portable paths,
artifact links/junctions, invalid schemas and identity mismatches fail closed.
The required runtime set includes CLI/server/V2 tools/Supervisor plus the two
dependency inputs. The sidecar has a 16 MiB size limit; filesystem enumeration
has a one-million-entry limit. Oversized inputs fail rather than truncate.

Shared node_modules is resolved to its real root. Its complete inventoried
tree fingerprint, critical package versions and native .node binary digests
are compared again during verification. Internal links are recorded without
recursive following; escaping links are rejected. This is deliberately named
`shared-verified-not-immutable`. Relocating the dependency root is also an
identity change. The recorded pnpm version is provenance supplied at sealing;
verification does not require pnpm to be installed or independently attest it.

## Sealing and verification

Run from a trusted checkout with the release's required runtime. Metadata JSON
must provide `buildId`, `sourceCommit`, `dirtyTree: false`, `requiredNodeMajor`,
`pnpmVersion`, `toolSchemaVersion`, `serverVersion` and
`databaseMigrationVersion`. Collect these from the build, not from an example
or a historical release. Catalog JSON is an array of observed tool definitions
or an object containing `tools`.

```text
node scripts/verify-release.mjs seal RELEASE_ROOT METADATA_JSON CATALOG_JSON
node scripts/verify-release.mjs verify RELEASE_ROOT TRUSTED_MANIFEST_SHA256
```

Sealing creates the sidecar exclusively and returns its SHA-256. Store that
hash in an independently controlled build record, not only beside the
candidate. Verification requires this trusted value before parsing metadata.
Changing both a candidate and its adjacent checksum is not trusted evidence.
An existing sidecar cannot be overwritten by sealing; create a new candidate.

Source commit, clean-tree status and catalog provenance are supplied, not
independently collected or signed. Native binary hashes prove identity, not
successful native loading. Fixtures deliberately use fake native bytes and
cannot establish Node 24 compatibility. Matching declared migration versions
does not independently attest a live database. The helper's builtAt value is
sealing time. These limitations prohibit a bit-for-bit reproducible-build,
provenance-attested, database-compatible, or deploy-ready claim.

## Offline rollback readiness

Create trusted context JSON containing the observed databaseMigrationVersion,
a nonempty protectedHashes object, and pointer metadata with buildId,
entryPoint and serverSha256. The preflight pointer must identify the rollback
release. Do not put tokens, configuration bodies or database contents in this
JSON. Store protected digests in restricted operational evidence rather than
publishing low-entropy secret digests.

```text
node scripts/verify-release.mjs snapshot CANDIDATE_ROOT CANDIDATE_SHA ROLLBACK_ROOT ROLLBACK_SHA BEFORE_CONTEXT_JSON SNAPSHOT_JSON
node scripts/verify-release.mjs postflight SNAPSHOT_JSON TRUSTED_SNAPSHOT_SHA256 AFTER_CONTEXT_JSON
```

Snapshot creates a new file and returns a hash to pin independently. Postflight
checks the snapshot hash, verifies both releases again, requires unchanged
protected hashes and migration version, and requires the observed pointer to
identify the candidate. No command changes the pointer or rolls back. Both
releases must declare exactly the observed migration version; unknown
cross-schema rollback compatibility is rejected, not guessed.

An older rollback release without a trustworthy sidecar cannot be silently
accepted. It needs a separately reviewed known-good baseline or remains
unverified. Never seal a possibly modified rollback candidate merely to make
verification pass.

## Windows and operational requirements

The no-profile preflight commands are:

```text
powershell.exe -NoProfile -NonInteractive -File scripts/test-release-preflight.ps1 -RequireNode24 -NodeExe NODE24_EXE
pwsh.exe -NoProfile -NonInteractive -File scripts/test-release-preflight.ps1 -RequireNode24 -NodeExe NODE24_EXE
```

The parser/hash tests cover command availability, all release PowerShell
syntax and a temporary path containing spaces. Actual packaged acceptance,
real native loading, approved runtime roots and live deployment/drain checks
remain separate requirements. No Windows execution is claimed from Linux.

Verification is a point-in-time check. It does not freeze a writable tree,
prevent post-check modification, authenticate a compromised build worker, or
eliminate filesystem races. Before/after stat checks catch ordinary concurrent
file changes but are not an adversarial snapshot primitive. Keep inputs under
trusted ownership, quiesce writers, pin evidence independently, and reverify
immediately before a separately authorized switch. Complete dependency hashing
has cost proportional to all dependency bytes; it has not been benchmarked on
the production tree.

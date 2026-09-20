# SEC-002 — Workspace mutation follows a junction outside the authorized root

- Severity: high
- Base: `main` `5b0fefa`
- Owner: `pro/v2.1-reliability-hardening` A14
- Status on main: CONFIRMED
- Status on owner branch: direct junction/final-symlink cases fixed; handle-race proof remains partial

## Trust boundary

Claude-compatible write/edit surfaces on main validate the requested path
lexically with `resolveAllowedPath`, then pass it to the underlying file tool.
They do not canonicalize the existing target/parent before mutation.

## Reproduction

In temporary test data, create `workspace/escape` as a directory junction to an
outside temporary directory, then call `writeFileTool` for
`escape/written.txt`. Main accepts the request and the bytes appear outside the
workspace root.

## Expected

Filesystem mutation tools must reject traversal, outside absolute paths,
escaping intermediate symlinks/junctions and final symlink targets. Shell
authority is a separate explicit model and is not changed by this finding.

## Impact

A project-controlled junction can redirect a nominal workspace-tool mutation to
another location writable by the local user, violating the workspace
containment guarantee.

## Recommended regression

Retain Windows junction, POSIX symlink, final-link, traversal and absolute-path
tests. A still records the external concurrent directory-replacement race as not
handle-proven; do not overstate that case as solved.

# Runtime recovery security boundaries

Recovery is infrastructure control, not an expansion of model or task authority. The runtime layer has no Git reset/clean/stash, task-claim, session-transfer, migration, workspace-write, conversation-rollover or release-selection API.

## Ownership and identity

An owner is fenced by token, epoch and process identity. A process must have an OS birth token and matching executable; entrypoint/build/version/root identity further restrict adoption. Expired time alone cannot authorize takeover. Unknown listeners and uncertain identities block. Forced termination uses a retained Windows handle or Linux pidfd, never a PID-only or process-tree fallback.

## State protection

Use a private, canonical runtime directory outside user workspaces and separate from orchestration databases. POSIX ownership and restrictive permissions are checked; symlink aliases and database symlinks are rejected. Provision and audit an appropriate private Windows ACL separately: this code does not install an ACL policy. All launchers for one instance must use the same directory.

SQLite WAL and synchronous FULL transactions protect against partial metadata publication. Corrupt/unreadable metadata is preserved and blocks recovery instead of being automatically reset. A runtime database is privileged local state, not untrusted input to repair by guesswork. Do not delete it while a registered process might still be alive.

## Approved code and credentials

The configuration, release-pointer bytes and entrypoint bytes are pinned and rechecked before launch. The pointer is read-only. This is not a signature or full imported-bundle integrity proof; immutable approved bundles and secure release publication remain deployment responsibilities.

Managed cloudflared additionally requires pinned executable and configuration hashes. Launches use fixed argument arrays without a shell. Runtime health uses an already approved bearer credential supplied through a named environment variable. Missing/expired credentials block; no OAuth client registration, owner-token exchange, MFA response or approval is performed automatically. Remote health redirects are not followed.

Configuration/credential material is not included in the public status projection. Owner/launch tokens and executable paths are excluded. Avoid placing secrets in build/version identifiers or operator-written metadata. Worker stdout/stderr are currently ignored rather than collected; no production log retention claim is made.

## Browser action safety

A possibly executed action is never retried automatically. Typed read-only disconnects may rediscover within the bounded policy. Approval failure is not a transport-repair request. Failed or unresolved browser teardown fences replacement creation. Existing trusted discovery and elicitation paths remain in force; there is no fallback that changes browser security settings.

## Fail-closed limitations

Native process identity is implemented for Windows/Linux only. Missing host capabilities, permission denial, changed releases, ambiguous native spawn results and exhausted budgets require attention. This deliberately trades unattended recovery coverage for avoiding destructive guesses. Full-project CI is not green; deployment remains gated as described in `TEST-MATRIX.md`.

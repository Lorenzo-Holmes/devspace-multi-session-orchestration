# DevSpace Runtime Doctor

Status: implementation checkpoint for `pro/runtime-doctor-host-compatibility`.

The Doctor is a read-only diagnostic surface. Standard and `--full` runs may
inspect local process/runtime metadata, configuration presence, TCP/DNS/TLS,
bounded HTTP protocol reachability, installed host tools, disk capacity and the
official Codex CUA runtime layout. It does not restart/kill processes, delete
locks, edit repositories/configuration, create chats, perform OAuth, attach a
browser or answer Browser/Computer approval prompts.

## Diagnostic model

Every check returns `id`, `category`, `status`, `severity`, `summary`,
`details`, `evidence`, `recommendation`, `durationMs` and `timestamp`.
Statuses are `pass`, `warn`, `fail`, `unknown` and `skipped`; UNKNOWN never
collapses to PASS. Categories are runtime, MCP, catalog, Computer Use, Browser,
Windows and configuration.

MCP diagnosis deliberately separates local listener reachability, local
protocol, public DNS, TLS, tunnel/OAuth-discovery routing and public MCP
protocol. Anonymous protocol probes send no owner/OAuth credential. Catalog
freshness remains UNKNOWN from the standalone CLI because a trustworthy host
catalog snapshot is not available there; authenticated `devspace_runtime_info`
is the comparison point.

Computer Use and Browser Use are separate checks. Computer Use validates the
official trusted Codex CUA discovery/runtime/pipe shape without launching an
arbitrary helper. Browser installation only establishes Edge/Chrome presence;
attachment, providerTabId, trusted URL, security block and authentication state
remain UNKNOWN until Browser Use reports them in an authorized host turn.

Windows checks cover Node runtime compatibility, Git, pnpm, Windows PowerShell,
optional PowerShell 7, `Microsoft.PowerShell.Utility`/`Get-FileHash` and disk
capacity. Support reports recursively redact token/password/cookie/private-key
material and credential-bearing URLs before JSON serialization.

## CLI

Supported forms:

```text
devspace doctor
devspace doctor --full
devspace doctor --json
devspace doctor --category browser
devspace doctor --support-bundle
```

Unknown options fail rather than silently changing behavior.

## Validation — 2026-09-20

- `git diff --check`: PASS
- `pnpm typecheck` under Node 24.19.0: PASS
- `src/runtime-doctor.test.ts`: PASS, 4/4, 0 skipped
- `pnpm build`: PASS (existing large-chunk warning only)
- real compiled CLI `doctor --json --category runtime`: PASS; Node 24.19.0 / ABI 137 identified
- real compiled CLI `doctor --json --category browser`: PASS for Edge/Chrome installation; attachment/origin correctly UNKNOWN
- secret-redaction/support-bundle regression: PASS

The standalone Doctor cannot safely prove the ChatGPT host's current Browser
attachment or catalog snapshot without using the authenticated host surfaces;
those limitations are represented as UNKNOWN, not as successful checks.

# Cloudflare tunnel ownership and recovery

The filename retains the requested `CLOUDFARE-TUNNEL.md` spelling. This implementation does not install cloudflared, create a tunnel, edit DNS, mint credentials or change ingress rules.

## External ownership (default)

With `tunnel.ownership` set to `external`, DevSpace may observe an explicitly configured HTTPS remote origin after local readiness. It does not discover processes by name, adopt an existing tunnel, restart a service, or kill cloudflared. Remote health failure degrades the aggregate runtime without transferring process ownership.

## Explicit managed ownership

Managed mode requires all of the following: an approved HTTPS `remoteUrl`; an absolute cloudflared executable with its SHA-256 `executableHash`; an absolute existing configuration file with its SHA-256 `configHash`; and a named tunnel UUID in `tunnelId`. The configured executable basename must be cloudflared or cloudflared.exe. Credentials remain operator-provisioned and are not embedded in recovery records.

The fixed launch arguments are:

```text
cloudflared tunnel --no-autoupdate --config <approved-config-file> run <named-tunnel-uuid>
```

No shell command is synthesized. Server readiness precedes tunnel launch. A verified tunnel crash may restart that component within both budgets. A living tunnel whose remote origin is unavailable is not automatically restarted: DNS, network, authentication and ingress problems cannot be inferred to be a process crash.

## Native spawn publication gap

The worker records `nativeLaunchStarted` before spawn. If it dies after a native process may have started but before its identity is published, the next supervisor cannot prove there is no child. It reports `UNCERTAIN_INFRASTRUCTURE_CHILD` and refuses duplicate launches. Do not delete the journal to force a retry. Inspect ownership and resolve the uncertain process out of band before an explicit handoff.

## Acceptance still required

Automated tests use fake managed/external tunnel observations and recovery sequences. No production Cloudflare tunnel, DNS record, account credential or domain was modified. Validate the actual Windows/Linux cloudflared configuration, remote MCP identity and intentional-stop behavior in an isolated deployment before enabling production management.

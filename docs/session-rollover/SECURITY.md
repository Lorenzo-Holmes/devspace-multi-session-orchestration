# Rollover security boundary

**Preparatory helpers only.** No production launcher, server opt-in, unattended Browser Use context,
identity handshake or authority transfer has been implemented. A pure preflight result cannot verify
its own provenance. Only a future trusted adapter may construct its input; never expose snapshot fields
as model-visible "approve" booleans or use caller-supplied account IDs as proof.

## Browser and approval requirements

Select the exact authorized browserId and requested tabId from fresh Browser Use inventory. Observe
current trusted URL and accessibility state; use the exact current tab/provider alias. Accept only
HTTPS chatgpt.com, with no userinfo, malformed/control-character URL, alternate origin or insecure
scheme. This helper conservatively rejects noncanonical explicit-port spellings too. Recheck before
and after every effect; a preflight cannot prevent a later redirect or account switch by itself.

Require verified expected account AND workspace IDs. A browser profile name or arbitrary AX text is
not an authenticated ChatGPT principal. Missing/changed identity blocks, rather than selecting another
account/tab. Verify DevSpace connectivity and current host catalog; supported refresh/reconnect must
be implemented separately, never fabricated.

Browser security unavailable, failed or denied is fail-closed. New origin/host permission, login,
MFA, OAuth consent or Computer Use approval stops for the user. Project opt-in only authorizes ordinary
continuation chat creation, fixed bootstrap send and resuming the existing authorized task; it does
not extend to new approvals, payments, account changes, secrets or destructive actions.

No auto-consent, CAPTCHA handling, email-code retrieval, TOTP entry, security-key emulation, desktop
fallback after browser denial, private ChatGPT API or fabricated host-turn identity is permitted.
This branch contains no browser/desktop transport calls at all.

## Prompt and data separation

The bootstrap has one fixed instruction template and strictly bounded identifier fields. Unknown
fields, freeform summaries, logs, raw capsule/history, passwords and nextAction text are rejected as
bootstrap input. IDs must be server-issued nonsecret opaque identifiers, not arbitrary user/project
text. A deterministic SHA-256 fingerprint provides comparison, not authenticity, authorization or
replay protection. Server-side reservation/receiver binding is still required.

Checkpoint/capsule data must be loaded through authenticated scoped tools and treated as untrusted
data, never appended as higher-priority instructions. Redaction/minimization must happen before durable
checkpoint export; this branch does not implement a general secret detector or capsule serializer.
Never claim that arbitrary secrets cannot occur in supplied strings just because a regex accepts them.

## Isolation and authority

Bind lookup to authenticated project scope, canonical logical session, intended handoff/rollover,
actual receiver conversation and worker incarnation. Validate repository, branch, worktree, commit/tree,
dirty state and active processes against actual local state. A matching prompt/fingerprint is not
proof that these identities match. Scope mismatches stop before reads of another project's memory
and before any mutation. Cross-project/session/replay integration tests remain required.

All late old-session mutations must pass reliability's generation/attempt/incarnation/session-revision
checks. Handoff acknowledgement, browser readiness and conversation URL do not transfer ownership.
The old owner is fenced by the atomic authority transaction, not by hoping its browser tab stops.

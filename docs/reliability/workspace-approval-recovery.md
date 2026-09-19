# Workspace approval atomicity and conservative recovery

## Authority and external effects are different things

Migration 20 adds request revisions, one decision reservation per request,
inactive prepared grants, once-use generations, an operation journal,
managed-root authority records, and a cross-connection configuration-writer
reservation. Existing version-18/19 grants remain readable; no prior migration
is edited and existing static configured roots remain supported.

An approval reserves a request revision **before** asynchronous filesystem
verification. A duplicate approval cannot reserve the same request. A human
denial, revocation or superseding request changes the durable request state;
after verification the original operation must re-read its reservation and
expiry, not act on the pre-verification request object.

Temporary grants and the approved request transition share one short SQLite
transaction, including the required audit event. A once grant uses a consumption
generation: an old failed-open cleanup cannot restore a later consumption.

Permanent approval is deliberately two-stage:

1. Commit an operation reservation, inactive prepared grant, managed-root marker,
   and configuration-writer reservation.
2. Persist the configured roots outside the SQLite transaction.
3. Recheck the request revision, operation, expiry, root generation and writer
   reservation. Atomically activate the grant, approve the request, update root
   authority, append the audit event and complete the journal.

The persisted configuration is a projection, not an approval receipt. A root
managed by this protocol never falls back to an unscoped `configured/modify`
grant. It requires its current active permanent grant and a still-present
configuration root. A failed Read approval therefore cannot become Modify just
because its configuration write reached disk. A later explicit removal from
configuration also invalidates the permanent grant.

## Revocation and concurrent writers

Revocation invalidates grants, pending decisions and managed-root authority in a
database transaction **before** configuration cleanup. If another configuration
writer is still reserved, or persistence fails, the tool returns
`configurationPending: true` with an `operationId`. Authorization is already
revoked; configuration cleanup is not represented as complete. A broader,
independently authorized root may still provide inherited access, which remains
explicit in the response.

Configuration writers are serialized across managers using the same database.
The production writer reads the current JSONC root list without loading
`auth.json`, so it does not replace an unrelated root using an old in-memory
list. A second approval encountering a held writer fails closed and needs a
fresh approval request; it never steals the writer reservation.

## Recovery protocol

The internal administrative methods are intentionally not exposed as automatic
approval tools and are never called by a read-only Doctor:

- `listOperations(limit, after)` reads the durable journal without approval
  tokens, configuration payloads or raw exception messages.
- `cancelOperationForRecovery(operationId, expectedRevision)` performs a CAS
  cancellation. It fences the old request and prepared grant and releases only
  that operation's writer reservation. It never grants access or replays an
  approval. A possibly executed configuration write remains
  `recovery_uncertain`; a fresh human approval is required for access.
- `resumeRevocationCleanup(operationId, expectedRevision)` explicitly retries
  only removal of a revoked configuration root. It does not recreate an
  approval, broaden the scope, delete project data, kill a process or approve a
  browser/OAuth prompt.

Recovery cancellation can fence an operation even if an old external writer
later returns. Its configuration entry remains non-authoritative. This does
not prove that a still-running external writer cannot affect configuration
availability: its `recovery_uncertain` journal must not be silently cleared.
Automatic recovery should be wired only after the canonical runtime supervisor
can establish the previous producer's lifecycle. No production recovery was
executed in this change, and no live grant database was migrated by the tests.

## Executed regression coverage

The isolated tests exercise real SQLite connections and, in a separate case,
the actual JSONC configuration writer. They cover simultaneous approvals,
approval versus denial/revocation, expiry during verification and after
configuration persistence, superseding requests, failed required audit inserts,
configuration-write-then-throw, late configuration writes after cancellation,
fresh explicit reapproval, serialized independent managers, stale once-use
restoration, and configuration cleanup failure.

Barrier-controlled late effects are not called real process-crash tests.
Hard power-loss, a killed production server, and cross-machine filesystem
coherency have not been tested. The journal and tests support conservative
recovery, not a claim of automatically successful recovery under every fault.

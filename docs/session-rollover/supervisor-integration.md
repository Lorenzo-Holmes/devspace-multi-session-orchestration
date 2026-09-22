# Supervisor integration boundary

No Supervisor semantics, tool capability catalog or recommendation model is modified.
The proposed adapter is read-only and cannot trigger scans that mutate rollover state, acquire a
lease, acknowledge a handoff or submit a browser action.

After durable runtime integration, expose authenticated project-scoped projections for logicalSession,
currentEpoch, rolloverCount, lastCheckpointAt, rolloverState and lastRolloverReason. Include observation
revision/time, availability and bounded paginated history so stale or incomplete data is visible.
Derive current owner from the authoritative session/generation transaction, not from an eventually
written source-superseded event or the existence of a conversation URL.

For this preparatory branch availability is dependency_blocked; all unimplemented runtime fields
remain unavailable. Do not fabricate current epoch/rollover counts from policy inputs or helper tests.
A helper's advisory `ready`/`safe`/`eligible` decision is not a new Supervisor execution state.

Coordinate the eventual adapter/tool exposure with `pro/control-plane-observability` and its final
schema. No extra model-visible tools are needed for this preparation. Cross-project access and
mutation-free reads require integration tests when the adapter is built.

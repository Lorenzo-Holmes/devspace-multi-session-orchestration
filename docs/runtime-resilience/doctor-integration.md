# Doctor and observability integration contract

This workstream does not depend on an unmerged doctor branch and does not add a model-visible control tool. Workstream F may consume the small runtime/health contracts after agreeing a versioned integration. Workstream C may render the read-only projection without acquiring supervisor authority.

## Available projection

`publicStatus(snapshot, policy)` exposes aggregate runtime state/generation, clean shutdown, recovery mode/enabled flag, last healthy/crash timestamps, window restart count, current recovery, blocked reason, component ownership/state/health and bounded events. Owner tokens, launch tokens and executable paths are not included. `runtimeRecoveryStatus()` on the CUA facade is an internal connection-status API, not a registered MCP tool.

`status` and `dry-run` read the existing journal in read-only mode. They describe committed observations, not guaranteed current host state. A consumer must display observation freshness and distinguish missing data, uncertain identity, blocked configuration and healthy readiness. A port being open is not sufficient health.

## Health contract

Health distinguishes process identity/liveness, owned listening port, HTTP readiness, MCP readiness and approved build/version/tool-catalog identity. Authentication and malformed/unknown responses must not be flattened into a generic restart recommendation. External tunnel observations do not grant local process ownership.

## Authority separation

A report may explain a blocked reason and show operator steps. Reading it must not call `control`, reserve a ticket, launch a process, authorize OAuth, clear a journal, switch release or mutate workspace/task state. Control integration requires a separate explicit design and approval, not an implicit side effect of doctor execution.

No shared orchestration migration, diagnostics report format, tool schema or UI contract was modified here. Keep these boundaries when consolidating the parallel branches.

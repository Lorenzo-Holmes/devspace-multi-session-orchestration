# Conversation rollover integration boundary

Runtime generations identify infrastructure launches. They are not conversation epochs, session ownership tokens, task attempts or authority to resume an interrupted action. Workstream E must retain its own durable rollover and execution-authorization rules.

A runtime reconnect or successful health check may be used as an availability signal only. It must not select a successor conversation, repeat a possibly executed tool action, reassign task/session ownership, approve an integration, or declare an interrupted business operation successful.

The supervisor restarts only the approved infrastructure entrypoint. It does not replay task queues or browser mutations. Persisted intentional stop and approval boundaries remain meaningful after a conversation or machine restart. An external consumer must reconcile its own idempotency and ownership before issuing new work.

Read-only status exposes the runtime generation and health observation for correlation. Correlation is not authorization: compare and present stale/new runtime information without modifying conversation epochs. Bounded runtime events are operational breadcrumbs, not substitutes for business evidence or task-attempt records.

No rollover module, conversation schema, orchestration database or task state machine was changed in this branch. Any future integration should test runtime restart during rollover and rollover during degraded health without crossing either authority boundary.

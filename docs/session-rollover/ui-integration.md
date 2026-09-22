# UI integration boundary

No visual changes or functional UI are included. The runtime is unavailable until reliability and
launcher integration pass. Display that state explicitly rather than showing a working auto-rollover
switch, fabricated epoch number or "context used" percentage.

Proposed read-only adapter fields (not an implemented endpoint): availability = dependency_blocked /
disabled / available; projectKey; logicalSessionId; currentEpoch; rolloverCount; lastCheckpointAt;
rolloverState; lastRolloverReason; contextPressure.level/confidence; requiresUserAction; blockerCode.
Unavailable values should be null/unknown, not zero or invented IDs. Populate only from authenticated
scoped durable records and source-attributed observations after that implementation exists.

During ordinary future rollover the user should see one continuing LogicalSession and bounded
progress, without repeated Continue/Send/Confirm controls. Only new platform approvals and explicit
reconciliation/attention states may request action. Approval cards must use existing platform
mechanisms; no UI code may synthesize acceptance or grant takeover authority.

Use the basic existing components for any eventual functional surface. Shared visual language,
Goal/Approval/Diagnostic Card design, animation and motion remain owned by
`pro/ui-visual-interaction-polish`. Do not change those files from this branch.

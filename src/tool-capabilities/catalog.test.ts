import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, ROLES } from "./types.js";
import { TOOL_CAPABILITIES, REVIEW_BASELINE, catalogForProfile, inventoryDocument } from "./catalog.js";
import { roleManifest } from "./roles.js";
import { recommendTools } from "./recommend.js";
const names = (tools = TOOL_CAPABILITIES) => tools.map(t => t.toolName);
const get = (name: string) => TOOL_CAPABILITIES.find(t => t.toolName === name)!;
test("manifest is sorted, unique, frozen, deterministic and fully classified", () => {
  assert.equal(TOOL_CAPABILITIES.length, 94); assert.equal(new Set(names()).size, 94);
  assert.deepEqual(names(), [...names()].sort()); assert.ok(Object.isFrozen(TOOL_CAPABILITIES));
  assert.equal(JSON.stringify(inventoryDocument()), JSON.stringify(inventoryDocument()));
  assert.deepEqual([...new Set(TOOL_CAPABILITIES.map(t => t.capability))].sort(), [...CAPABILITIES].sort());
  for (const t of TOOL_CAPABILITIES) {
    assert.ok(Object.isFrozen(t.prerequisites)); assert.ok(t.purpose.length > 20); assert.ok(t.sourceFiles.length);
    assert.ok(t.intent && t.namespace && t.risk && t.idempotency);
    for (const n of [...t.typicalPredecessors, ...t.typicalSuccessors]) assert.ok(get(n), `${t.toolName} -> ${n}`);
  }
});
test("source union is not a simultaneous runtime catalog; review profile is 84/78/6", () => {
  const profile = catalogForProfile(REVIEW_BASELINE);
  assert.equal(profile.length, 84); assert.equal(profile.filter(t => t.visibility === "model-visible").length, 78);
  assert.deepEqual(profile.filter(t => t.visibility === "app-only").map(t => t.toolName), ["approve_workspace_access", "chat_card_probe_status", "chat_card_probe_submit", "chat_goal_card_status", "chat_goal_card_submit", "computer_approval_submit"]);
  assert.ok(!names(profile).includes("goal_start")); assert.ok(!names(profile).includes("download_artifact"));
  assert.throws(() => catalogForProfile({ ...REVIEW_BASELINE, nativeGoals: true }));
  assert.throws(() => catalogForProfile({ ...REVIEW_BASELINE, ui: false }));
});
test("mode, platform, UI and registration-dependency variants remain distinct", () => {
  const linux = catalogForProfile({ ...REVIEW_BASELINE, platform: "linux", artifacts: true });
  assert.ok(names(linux).includes("download_artifact")); assert.ok(!names(linux).includes("computer"));
  const claude = catalogForProfile({ ...REVIEW_BASELINE, toolMode: "claude" });
  assert.ok(names(claude).includes("bash")); assert.ok(!names(claude).includes("exec_command"));
  assert.ok(!names(catalogForProfile({ ...REVIEW_BASELINE, sessions: false })).includes("coordinator_claim"));
  assert.ok(!names(catalogForProfile({ ...REVIEW_BASELINE, cuaBridge: false })).includes("browser_state"));
  assert.equal(catalogForProfile({ ...REVIEW_BASELINE, ui: false, diagnosticCards: false }).find(t => t.toolName === "approve_workspace_access")!.visibility, "model-visible");
});
test("risk, side effect and abstract precondition boundaries are explicit", () => {
  for (const n of ["exec_command", "write_stdin", "computer", "browser_action", "goal_start", "approve_workspace_access"]) assert.equal(get(n).risk, "high");
  assert.equal(get("integration_status").mutability, "read"); assert.equal(get("integration_gate").mutability, "mutate");
  assert.equal(get("show_changes").localStateMutation, "incidental");
  assert.equal(get("chat_card_probe_status").localStateMutation, "yes");
  assert.equal(get("chat_goal_create").projectMutation, "possible");
  assert.ok(!get("chat_goal_create").constraints.includes("metadataOnly"));
  assert.ok(!get("goal_start").constraints.includes("doesNotSpawnModel"));
  for (const n of ["coordinator_release", "coordinator_complete", "worktree_provision", "chat_goal_complete"]) assert.ok(get(n).prerequisites.requiresCurrentTaskAuthority);
  assert.ok(get("worktree_cleanup_status").constraints.includes("doesNotDeleteWorktree"));
});
test("roles partition every tool without granting authority; observer and supervisor never recommend writes", () => {
  for (const role of roleManifest()) {
    assert.ok(ROLES.includes(role.role)); assert.equal(role.authorization, false);
    const all = [...role.recommended, ...role.conditional, ...role.humanGated, ...role.defaultForbidden];
    assert.equal(all.length, 84); assert.equal(new Set(all).size, 84);
    if (role.role === "Observer" || role.role === "Supervisor") {
      assert.equal(role.conditional.length, 0);
      for (const name of role.recommended) assert.equal(get(name).mutability, "read");
    }
  }
});
test("missing context, missing host tools and untrusted role labels do not authorize", () => {
  const result = recommendTools({ role: "Operator", workspace: "unknown" });
  assert.equal(result.authorization, false); assert.equal(result.recommended.length, 0);
  assert.equal(result.hiddenCandidate.length, 6);
  assert.deepEqual(recommendTools({ role: "Worker", workspace: "modify", intent: "file.read", hostToolNames: [] }).recommended, []);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { replaceAllowedRoots, WorkspaceAccessManager, type WorkspaceAccessManagerOptions } from "./workspace-access.js";
import { setDevspaceConfigValue } from "./user-config.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-approval-cas-"));
  const project = join(root, "requested"), allowed = join(root, "allowed");
  await mkdir(project); await mkdir(allowed);
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [allowed], worktreeRoot: join(root, "worktrees") },
    storage: { stateDir: join(root, "state") },
  }));
  const db = openDatabase(config.stateDir), managers: WorkspaceAccessManager[] = [];
  let storedRoots = [...config.allowedRoots];
  const setRoots = (roots: string[]) => { storedRoots = [...roots]; replaceAllowedRoots(config, roots); };
  const make = (options: WorkspaceAccessManagerOptions = {}) => {
    const manager = new WorkspaceAccessManager(config, { persistAllowedRoots: setRoots,
      readAllowedRoots: () => [...storedRoots], ...options });
    managers.push(manager); return manager;
  };
  const native = () => { const manager = new WorkspaceAccessManager(config); managers.push(manager); return manager; };
  t.after(async () => { for (const manager of managers) manager.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, allowed, config, db, make, native, setRoots, roots: () => [...storedRoots] };
}

test("approve + approve reserves one decision before async filesystem verification", async (t) => {
  const f = await fixture(t), entered = barrier(), release = barrier();
  const first = f.make({ verifyFilesystemAccess: async () => { entered.release(); await release.promise; } }), second = f.make();
  const request = await first.requestAccess({ path: f.project, access: "modify", conversationScopeId: "chat" });
  const input = { requestId: request.id, approvalToken: request.approvalToken!, decision: "once" as const, conversationScopeId: "chat" };
  const pending = first.decideRequest(input);
  await entered.promise;
  await assert.rejects(second.decideRequest(input), /reserved decision/);
  release.release();
  await pending;
  assert.equal(first.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 1);
  assert.equal((f.db.sqlite.prepare("select count(*) as n from workspace_access_grants where request_id = ?").get(request.id) as { n: number }).n, 1);
});

for (const decision of ["once", "permanent"] as const) {
  test(`${decision}: deny and revoke fence a reserved approval before verification returns`, async (t) => {
    for (const cancellation of ["deny", "revoke"] as const) {
      const f = await fixture(t), entered = barrier(), release = barrier();
      const first = f.make({ verifyFilesystemAccess: async () => { entered.release(); await release.promise; } }), other = f.make();
      const request = await first.requestAccess({ path: f.project, access: "modify", conversationScopeId: "chat" });
      const pending = first.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision, conversationScopeId: "chat" });
      const rejection = assert.rejects(pending, /no longer pending/);
      await entered.promise;
      if (cancellation === "deny") await other.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "deny", conversationScopeId: "chat" });
      else await other.revokePath(f.project);
      release.release(); await rejection;
      assert.equal(other.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 0);
      await assert.rejects(other.authorizeWorkspacePath(f.project, "chat"), /outside approved roots/);
    }
  });
}

test("expiry during filesystem verification creates no grant", async (t) => {
  const f = await fixture(t), entered = barrier(), release = barrier();
  let clock = Date.parse("2026-09-19T10:00:00.000Z");
  const manager = f.make({ now: () => new Date(clock), requestTtlMs: 1000,
    verifyFilesystemAccess: async () => { entered.release(); await release.promise; } });
  const request = await manager.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  const rejected = assert.rejects(manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "session", conversationScopeId: "chat" }), /expired/);
  await entered.promise; clock += 1001; release.release(); await rejected;
  assert.equal((f.db.sqlite.prepare("select count(*) as n from workspace_access_grants").get() as { n: number }).n, 0);
});

test("a replaced request cannot be approved by the old verifier", async (t) => {
  const f = await fixture(t), entered = barrier(), release = barrier();
  const old = f.make({ verifyFilesystemAccess: async () => { entered.release(); await release.promise; } }), current = f.make();
  const request = await old.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  const rejected = assert.rejects(old.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "once", conversationScopeId: "chat" }), /no longer pending/);
  await entered.promise;
  const replacement = await current.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  await current.decideRequest({ requestId: replacement.id, approvalToken: replacement.approvalToken!, decision: "once", conversationScopeId: "chat" });
  release.release(); await rejected;
  assert.equal(current.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 1);
});

test("configuration write followed by failure never creates a fallback Modify grant, including after restart", async (t) => {
  const f = await fixture(t);
  const manager = f.make({ persistAllowedRoots: roots => { f.setRoots(roots); throw new Error("fixture-secret-must-not-enter-journal"); } });
  const request = await manager.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  await assert.rejects(manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "permanent", conversationScopeId: "chat" }), /not committed/);
  assert.ok(f.roots().includes(f.project), "external effect may really have happened");
  const restarted = f.make();
  await assert.rejects(restarted.authorizeWorkspacePath(f.project, "other"), /outside approved roots/);
  assert.equal(restarted.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 0);
  assert.ok(restarted.listOperations().some(operation => operation.phase === "recovery_uncertain"));
  assert.equal(JSON.stringify(restarted.listOperations()).includes("fixture-secret"), false);
  const fresh = await restarted.requestAccess({ path: f.project, access: "read", conversationScopeId: "new-chat" });
  assert.equal(fresh.status, "pending", "a stale configuration entry is not an existing approval");
  await restarted.decideRequest({ requestId: fresh.id, approvalToken: fresh.approvalToken!, decision: "permanent", conversationScopeId: "new-chat" });
  assert.equal((await restarted.authorizeWorkspacePath(f.project, "another-chat")).access, "read");
  await assert.rejects(restarted.authorizeWorkspacePath(f.project, "another-chat", "modify"), /only read/);
});

for (const cancellation of ["deny", "revoke", "recovery"] as const) {
  test(`a late permanent configuration effect cannot override ${cancellation}`, async (t) => {
    const f = await fixture(t), entered = barrier(), release = barrier();
    const first = f.make({ persistAllowedRoots: async roots => { entered.release(); await release.promise; f.setRoots(roots); } }), other = f.make();
    const request = await first.requestAccess({ path: f.project, access: "modify", conversationScopeId: "chat" });
    const rejected = assert.rejects(first.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "permanent", conversationScopeId: "chat" }), /no longer pending/);
    await entered.promise;
    assert.equal(other.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 0);
    let revocationId: string | undefined;
    if (cancellation === "deny") await other.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "deny", conversationScopeId: "chat" });
    else if (cancellation === "revoke") {
      const result = await other.revokePath(f.project);
      assert.equal(result.configurationPending, true);
      revocationId = result.operationId;
    } else {
      const operation = other.listOperations().find(value => value.request_id === request.id)!;
      assert.equal(other.cancelOperationForRecovery(operation.id, operation.revision).phase, "recovery_uncertain");
      assert.throws(() => other.cancelOperationForRecovery(operation.id, operation.revision), /revision conflict/);
    }
    release.release(); await rejected;
    assert.ok(f.roots().includes(f.project), "simulate the actual late external effect");
    await assert.rejects(other.authorizeWorkspacePath(f.project, "chat"), /outside approved roots/);
    if (revocationId) {
      const operation = other.listOperations().find(value => value.id === revocationId)!;
      assert.equal(await other.resumeRevocationCleanup(operation.id, operation.revision), true);
      assert.equal(f.roots().includes(f.project), false);
    }
  });
}

for (const decision of ["once", "permanent"] as const) {
  test(`${decision}: required approval audit failure rolls back authority and leaves a recovery record`, async (t) => {
    const f = await fixture(t), manager = f.make();
    f.db.sqlite.exec(`create trigger fail_grant_audit before insert on workspace_access_audit
      when new.event = 'grant_approved' begin select raise(abort, 'injected final audit failure'); end`);
    const request = await manager.requestAccess({ path: f.project, access: "modify", conversationScopeId: "chat" });
    await assert.rejects(manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision, conversationScopeId: "chat" }), /not committed/);
    await assert.rejects(manager.authorizeWorkspacePath(f.project, "chat"), /outside approved roots/);
    assert.equal(manager.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 0);
    assert.ok(manager.listOperations().some(operation => ["failed", "recovery_uncertain"].includes(operation.phase)));
  });
}

test("an old failed-open restoration cannot restore a later once-grant consumption", async (t) => {
  const f = await fixture(t), manager = f.make();
  const request = await manager.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  await manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "once", conversationScopeId: "chat" });
  const first = await manager.authorizeWorkspacePath(f.project, "chat");
  manager.releaseOnceAuthorization(first);
  const second = await manager.authorizeWorkspacePath(f.project, "chat");
  assert.notEqual(second.useGeneration, first.useGeneration);
  manager.releaseOnceAuthorization(first);
  await assert.rejects(manager.authorizeWorkspacePath(f.project, "chat"), /outside approved roots/);
  assert.doesNotThrow(() => manager.assertWorkspaceReadable({ root: f.project, accessMode: "read", accessGrantId: second.grantId }));
});

test("configuration writers are serialized across independent managers and preserve other roots", async (t) => {
  const f = await fixture(t), entered = barrier(), release = barrier();
  const secondProject = join(f.root, "second"); await mkdir(secondProject);
  const first = f.make({ persistAllowedRoots: async roots => { entered.release(); await release.promise; f.setRoots(roots); } }), other = f.make();
  const request = await first.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  const pending = first.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "permanent", conversationScopeId: "chat" });
  await entered.promise;
  const conflicting = await other.requestAccess({ path: secondProject, access: "read", conversationScopeId: "second" });
  await assert.rejects(other.decideRequest({ requestId: conflicting.id, approvalToken: conflicting.approvalToken!, decision: "permanent", conversationScopeId: "second" }), /configuration operation is still in progress/);
  release.release(); await pending;
  const fresh = await other.requestAccess({ path: secondProject, access: "read", conversationScopeId: "second" });
  await other.decideRequest({ requestId: fresh.id, approvalToken: fresh.approvalToken!, decision: "permanent", conversationScopeId: "second" });
  assert.ok(f.roots().includes(f.project)); assert.ok(f.roots().includes(secondProject)); assert.ok(f.roots().includes(f.allowed));
});

test("native JSONC persistence survives reopen as read-only and respects later configuration removal", async (t) => {
  const f = await fixture(t), manager = f.native();
  const request = await manager.requestAccess({ path: f.project, access: "read", conversationScopeId: "chat" });
  await manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "permanent", conversationScopeId: "chat" });
  const reopened = f.native();
  const grant = await reopened.authorizeWorkspacePath(f.project, "other");
  assert.equal(grant.access, "read");
  await assert.rejects(reopened.authorizeWorkspacePath(f.project, "other", "modify"), /only read/);
  setDevspaceConfigValue(["workspaces", "allowedRoots"], [f.allowed], { ...process.env, DEVSPACE_CONFIG_DIR: f.config.configDir });
  await assert.rejects(reopened.authorizeWorkspacePath(f.project, "other"), /outside approved roots/);
});

test("expiry after configuration persistence still cannot activate the prepared grant", async (t) => {
  const f = await fixture(t);
  let clock = Date.parse("2026-09-19T12:00:00.000Z");
  const manager = f.make({ now: () => new Date(clock), requestTtlMs: 1000,
    persistAllowedRoots: roots => { f.setRoots(roots); clock += 1001; } });
  const request = await manager.requestAccess({ path: f.project, access: "modify", conversationScopeId: "chat" });
  await assert.rejects(manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "permanent", conversationScopeId: "chat" }), /expired/);
  assert.ok(f.roots().includes(f.project));
  await assert.rejects(manager.authorizeWorkspacePath(f.project, "chat"), /outside approved roots/);
  assert.equal(manager.listGrants("chat").filter(grant => grant.path === f.project && grant.active).length, 0);
});

test("failed revocation persistence reports pending cleanup but authority is already revoked", async (t) => {
  const f = await fixture(t), manager = f.make();
  const request = await manager.requestAccess({ path: f.project, access: "modify", conversationScopeId: "chat" });
  await manager.decideRequest({ requestId: request.id, approvalToken: request.approvalToken!, decision: "permanent", conversationScopeId: "chat" });
  const failing = f.make({ persistAllowedRoots: () => { throw new Error("injected configuration write failure"); } });
  const revoked = await failing.revokePath(f.project);
  assert.equal(revoked.configurationPending, true);
  assert.equal(revoked.removedFromConfig, false);
  assert.ok(f.roots().includes(f.project));
  await assert.rejects(manager.authorizeWorkspacePath(f.project, "chat"), /outside approved roots/);
  const operation = manager.listOperations().find(row => row.id === revoked.operationId)!;
  assert.equal(await manager.resumeRevocationCleanup(operation.id, operation.revision), true);
  assert.equal(f.roots().includes(f.project), false);
});

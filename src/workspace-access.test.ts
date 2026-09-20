import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, type ServerConfig } from "./config.js";
import { AccessDeniedError } from "./roots.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import {
  accessRisk,
  WorkspaceAccessManager,
} from "./workspace-access.js";

test("approval tokens are required and never appear in grant or audit listings", async (t) => {
  const context = await fixture(t);
  const request = await context.manager.requestAccess({
    path: context.project,
    access: "modify",
    reason: "Run project tests",
    conversationScopeId: "chat-1",
  });

  assert.equal(request.status, "pending");
  assert.match(request.approvalToken ?? "", /^[A-Za-z0-9_-]{40,}$/);
  await assert.rejects(
    context.manager.decideRequest({
      requestId: request.id,
      approvalToken: "not-the-card-token-not-the-card-token",
      decision: "once",
      conversationScopeId: "chat-1",
    }),
    AccessDeniedError,
  );

  assert.equal(JSON.stringify(context.manager.listGrants("chat-1")).includes(request.approvalToken!), false);
  assert.equal(JSON.stringify(context.manager.listAudit()).includes(request.approvalToken!), false);
});

test("allow once is conversation-bound and consumed by one workspace open", async (t) => {
  const context = await fixture(t);
  const request = await context.manager.requestAccess({
    path: context.project,
    access: "modify",
    conversationScopeId: "chat-1",
  });
  const approved = await context.manager.decideRequest({
    requestId: request.id,
    approvalToken: request.approvalToken!,
    decision: "once",
    conversationScopeId: "chat-1",
  });

  await assert.rejects(
    context.manager.authorizeWorkspacePath(context.project, "chat-2"),
    AccessDeniedError,
  );
  const authorization = await context.manager.authorizeWorkspacePath(context.project, "chat-1");
  assert.equal(authorization.scope, "once");
  assert.equal(authorization.access, "modify");
  assert.equal(authorization.consumedOnce, true);
  assert.equal(authorization.grantId, approved.grantId);
  await assert.rejects(
    context.manager.authorizeWorkspacePath(context.project, "chat-1"),
    AccessDeniedError,
  );

  assert.doesNotThrow(() => context.manager.assertWorkspaceModifiable({
    root: context.project,
    accessMode: "modify",
    accessGrantId: authorization.grantId,
  }));
});

test("session read access can be reused but blocks every mutating tool class", async (t) => {
  const context = await fixture(t);
  const request = await context.manager.requestAccess({
    path: context.project,
    access: "read",
    conversationScopeId: "chat-1",
  });
  await context.manager.decideRequest({
    requestId: request.id,
    approvalToken: request.approvalToken!,
    decision: "session",
    conversationScopeId: "chat-1",
  });

  const first = await context.manager.authorizeWorkspacePath(context.project, "chat-1");
  const second = await context.manager.authorizeWorkspacePath(context.project, "chat-1");
  assert.equal(first.grantId, second.grantId);
  assert.equal(first.access, "read");
  assert.doesNotThrow(() => context.manager.assertWorkspaceReadable({
    root: context.project,
    accessMode: "read",
    accessGrantId: first.grantId,
  }));
  assert.throws(() => context.manager.assertWorkspaceModifiable({
    root: context.project,
    accessMode: "read",
    accessGrantId: first.grantId,
  }), AccessDeniedError);

  const restoreRoots = context.manager.workspaceRestoreAllowedRoots({
    root: context.project,
    mode: "checkout",
    accessMode: "read",
    accessGrantId: first.grantId,
  });
  assert.ok(restoreRoots.includes(context.project));

  await context.manager.revokePath(context.project);
  assert.throws(() => context.manager.workspaceRestoreAllowedRoots({
    root: context.project,
    mode: "checkout",
    accessMode: "read",
    accessGrantId: first.grantId,
  }), AccessDeniedError);
});

test("permanent approval updates live roots and revoke invalidates an open workspace", async (t) => {
  const context = await fixture(t);
  const request = await context.manager.requestAccess({
    path: context.project,
    access: "modify",
    conversationScopeId: "chat-1",
  });
  const approved = await context.manager.decideRequest({
    requestId: request.id,
    approvalToken: request.approvalToken!,
    decision: "permanent",
    conversationScopeId: "chat-1",
  });

  assert.ok(context.config.allowedRoots.includes(context.project));
  const authorization = await context.manager.authorizeWorkspacePath(context.project, "chat-2");
  assert.equal(authorization.scope, "permanent");
  assert.equal(authorization.access, "modify");

  const revoked = await context.manager.revokePath(context.project);
  assert.equal(revoked.removedFromConfig, true);
  assert.equal(revoked.revokedGrantCount, 1);
  assert.throws(() => context.manager.assertWorkspaceReadable({
    root: context.project,
    accessMode: "modify",
    accessGrantId: approved.grantId,
  }), AccessDeniedError);
});

test("drive roots are marked high risk", () => {
  assert.equal(accessRisk(parse(process.cwd()).root), "high");
});

interface TestFixture {
  config: ServerConfig;
  manager: WorkspaceAccessManager;
  project: string;
}

async function fixture(t: TestContext): Promise<TestFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-access-test-")));
  const allowedPath = join(root, "allowed");
  const projectPath = join(root, "requested-project");
  const stateDir = join(root, "state");
  await mkdir(allowedPath, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  const allowed = await realpath(allowedPath);
  const project = await realpath(projectPath);
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: {
      allowedRoots: [allowed],
      worktreeRoot: join(root, "worktrees"),
    },
    storage: { stateDir },
  }));
  const manager = new WorkspaceAccessManager(config, {
    persistAllowedRoots: (roots) => {
      config.allowedRoots.splice(0, config.allowedRoots.length, ...roots);
    },
  });

  t.after(async () => {
    manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return { config, manager, project };
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWebSocketHub, openDevDatabase, routeEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { endpoint, job, mutation } from "../dist/server.js";
import { createAdditionalTeam } from "../dist/teams-runtime.js";

const capsule = {
  name: "teams-test",
  schema: {},
  queries: {
    ownTeams: {
      kind: "query",
      handler: (ctx) => ctx.teams.list(),
    },
    ownTeamMembers: {
      kind: "query",
      handler: async (ctx) => {
        const { teams } = await ctx.teams.list();
        return ctx.teams.listMembers(teams[0].id);
      },
    },
  },
  mutations: {
    createAdditionalTeam: mutation((ctx, name) => ctx.teams.create(name)),
    renameAdditionalTeam: mutation((ctx, teamId, name) => ctx.teams.rename(teamId, name)),
    createAndQueue: mutation(async (ctx, name) => {
      const created = await ctx.teams.create(name);
      await ctx.jobs.enqueue("queued", {}, { idempotencyKey: "teams-audit-flush" });
      return created;
    }),
  },
  endpoints: {
    renameAdditionalTeam: endpoint({ method: "POST", path: "/teams/rename" }, async (ctx) => ({
      status: 200,
      body: await ctx.teams.rename(ctx.request.body.teamId, ctx.request.body.name),
    })),
  },
  jobs: { queued: job(() => null) },
};

test("a newly linked caller immediately receives one persistent singleton Team through public and trusted current-user seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-"));
  const databasePath = path.join(dir, "data.db");
  let runtime = await startRuntime(databasePath);
  let anonymous;
  let linked;
  try {
    anonymous = await runtime.open();
    const anonymousAuth = await send(anonymous, { id: "anonymous-auth", type: "auth.get" });
    const denied = await send(anonymous, { id: "anonymous-teams", type: "teams.list" });
    assert.equal(denied.error.code, "UNAUTHENTICATED");

    const signedUp = await send(anonymous, {
      id: "signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "owner@example.com", password: "password-123", name: "Owner" },
    });
    assert.equal(signedUp.error, null, JSON.stringify(signedUp.error));
    assert.equal(
      runtime.database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [createdByUserId] = ?").get(signedUp.data.auth.userId).count,
      1,
      "email account linking commits the initial Team before any Team-interface call",
    );

    linked = await runtime.open();
    const [first, concurrent] = await Promise.all([
      send(anonymous, { id: "teams-first", type: "teams.list" }),
      send(linked, { id: "teams-concurrent", type: "teams.list", sessionToken: signedUp.data.sessionToken }),
    ]);
    assert.equal(first.error, null, JSON.stringify(first.error));
    assert.deepEqual(first.data, concurrent.data, "concurrent calls create no extra singleton Team");
    assert.equal(first.data.teams.length, 1);
    assert.deepEqual(Object.keys(first.data.teams[0]).sort(), ["applicationRoles", "id", "memberCount", "name", "role"]);
    assert.equal(first.data.teams[0].role, "admin");
    assert.deepEqual(first.data.teams[0].applicationRoles, []);
    assert.equal(first.data.teams[0].memberCount, 1);
    assert.match(first.data.teams[0].id, /^[0-9a-f-]{36}$/i);
    assert.ok(first.data.teams[0].name.length > 0 && first.data.teams[0].name.length <= 80);

    const repeated = await send(linked, { id: "teams-repeat", type: "teams.list", sessionToken: signedUp.data.sessionToken });
    assert.deepEqual(repeated.data, first.data, "retries create no extra singleton Team");

    const trusted = await runQuery(runtime.database, signedUp.data.auth, "ownTeams");
    assert.deepEqual(trusted, { data: first.data, error: null });

    linked.close(); linked = null;
    anonymous.close(); anonymous = null;
    await runtime.close();
    runtime = await startRuntime(databasePath);
    linked = await runtime.open();
    const afterRestart = await send(linked, { id: "teams-after-restart", type: "teams.list", sessionToken: signedUp.data.sessionToken });
    assert.deepEqual(afterRestart.data, first.data, "runtime-owned Team state persists across restart");
    assert.equal(anonymousAuth.data.auth.isGuest, true, "the anonymous denial creates no Team state");
  } finally {
    anonymous?.close(); linked?.close();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Team membership lists are safe, bounded, and scoped to the current admin through browser and trusted seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-memberships-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let otherAdmin;
  let member;
  let stranger;
  try {
    owner = await runtime.open();
    otherAdmin = await runtime.open();
    member = await runtime.open();
    stranger = await runtime.open();
    const ownerSignUp = await signUp(owner, "members-owner", "members-owner@example.com", "Owner");
    const otherAdminSignUp = await signUp(otherAdmin, "members-other-admin", "members-other-admin@example.com", "Other Admin");
    const memberSignUp = await signUp(member, "members-member", "members-member@example.com", "Member");
    const strangerSignUp = await signUp(stranger, "members-stranger", "members-stranger@example.com", "Stranger");
    const ownerTeams = await send(owner, { id: "members-owner-teams", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken });
    const otherAdminTeams = await send(otherAdmin, { id: "members-other-admin-teams", type: "teams.list", sessionToken: otherAdminSignUp.data.sessionToken });
    const teamA = ownerTeams.data.teams[0].id;
    const teamB = otherAdminTeams.data.teams[0].id;
    await runtime.database.adapter.withTransaction(async (tx) => {
      const now = new Date().toISOString();
      const memberCreatedAt = new Date(Date.now() - 1_000).toISOString();
      await tx.updateAuthUserProfile({ id: ownerSignUp.data.auth.userId, displayName: "Owner", picture: "https://example.com/owner.png", isAuthenticated: 1, isGuest: 0 });
      await tx.updateAuthUserProfile({ id: memberSignUp.data.auth.userId, displayName: "Member", picture: "https://example.com/member.png", isAuthenticated: 1, isGuest: 0 });
      await tx.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(teamA, memberSignUp.data.auth.userId, memberCreatedAt);
      await tx.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(teamB, memberSignUp.data.auth.userId, memberCreatedAt);
      for (let index = 0; index < 110; index += 1) {
        const userId = `bounded-member-${index}`;
        await tx.insertAuthUser({ id: userId, createdAt: now, displayName: `Bounded ${index}`, email: `bounded-${index}@example.com`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
        await tx.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(teamA, userId, now);
      }
    });

    const browser = await send(owner, { id: "members-owner-list", type: "teams.listMembers", teamId: teamA, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(browser.error, null, JSON.stringify(browser.error));
    assert.equal(browser.type, "teams.listMembers.result");
    assert.ok(browser.data.members.length > 1 && browser.data.members.length <= 100, "the member directory has a fixed response bound");
    assert.deepEqual(Object.keys(browser.data.members[0]).sort(), ["applicationRoles", "displayName", "picture", "role", "userId"]);
    assert.deepEqual(browser.data.members.find((entry) => entry.userId === ownerSignUp.data.auth.userId), {
      userId: ownerSignUp.data.auth.userId, displayName: "Owner", picture: "https://example.com/owner.png", role: "admin", applicationRoles: [],
    });
    assert.deepEqual(browser.data.members.find((entry) => entry.userId === memberSignUp.data.auth.userId), {
      userId: memberSignUp.data.auth.userId, displayName: "Member", picture: "https://example.com/member.png", role: "member", applicationRoles: [],
    });
    assertNoTeamLeak(browser.data, ["members-owner@example.com", "members-member@example.com", "bounded-0@example.com", "password", "sessionToken", "provider"]);

    const trusted = await runQuery(runtime.database, ownerSignUp.data.auth, "ownTeamMembers");
    assert.deepEqual(trusted, { data: browser.data, error: null }, "trusted handler calls share the browser result and authorization contract");

    const ordinaryMember = await send(member, { id: "members-ordinary-denied", type: "teams.listMembers", teamId: teamA, sessionToken: memberSignUp.data.sessionToken });
    const otherTeamAdmin = await send(otherAdmin, { id: "members-cross-team-denied", type: "teams.listMembers", teamId: teamA, sessionToken: otherAdminSignUp.data.sessionToken });
    const nonMember = await send(stranger, { id: "members-nonmember-denied", type: "teams.listMembers", teamId: teamA, sessionToken: strangerSignUp.data.sessionToken });
    const malformed = await send(stranger, { id: "members-malformed-denied", type: "teams.listMembers", teamId: "not-a-team-id", sessionToken: strangerSignUp.data.sessionToken });
    for (const denied of [ordinaryMember, otherTeamAdmin, nonMember, malformed]) {
      assert.equal(denied.type, "error");
      assert.equal(denied.error.code, "DENIED");
      assertNoTeamLeak(denied, [teamA, "members-owner@example.com", "Owner"]);
    }
  } finally {
    owner?.close(); otherAdmin?.close(); member?.close(); stranger?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("linked users create and rename explicit additional Teams through browser and trusted seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-additional-"));
  const databasePath = path.join(dir, "data.db");
  let runtime = await startRuntime(databasePath);
  let owner;
  let stranger;
  try {
    owner = await runtime.open();
    const signedUp = await send(owner, {
      id: "additional-owner-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "additional-owner@example.com", password: "password-123", name: "Additional Owner" },
    });
    assert.equal(signedUp.error, null, JSON.stringify(signedUp.error));

    const created = await send(owner, { id: "additional-create", type: "teams.create", name: "  Ｐｒｏｄｕｃｔ\u00a0Team  " });
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.deepEqual(created.data, {
      team: {
        id: created.data.team.id,
        name: "Product Team",
        role: "admin",
        applicationRoles: [],
        memberCount: 1,
      },
    });

    const invalid = await send(owner, { id: "additional-invalid-name", type: "teams.create", name: "   " });
    assert.equal(invalid.error.code, "INVALID_TEAM_NAME");
    const nonString = await send(owner, { id: "additional-non-string", type: "teams.create", name: { value: "nope" } });
    assert.equal(nonString.error.code, "INVALID_TEAM_NAME");
    const eightyBytes = await send(owner, { id: "additional-eighty-bytes", type: "teams.create", name: "a".repeat(80) });
    assert.equal(eightyBytes.error, null, JSON.stringify(eightyBytes.error));
    const tooLong = await send(owner, { id: "additional-too-long", type: "teams.create", name: "a".repeat(81) });
    assert.equal(tooLong.error.code, "INVALID_TEAM_NAME");

    const listed = await send(owner, { id: "additional-list", type: "teams.list" });
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(listed.data.teams.length, 3);
    const singleton = listed.data.teams.find((team) => team.name === "My Team");
    assert.ok(singleton);
    assert.deepEqual(new Set(listed.data.teams.map((team) => team.id)), new Set([singleton.id, created.data.team.id, eightyBytes.data.team.id]));

    const trustedCreate = await runMutation(runtime.database, signedUp.data.auth, "createAdditionalTeam", ["Trusted Team"]);
    assert.equal(trustedCreate.error, null, JSON.stringify(trustedCreate.error));
    assert.equal(trustedCreate.data.team.name, "Trusted Team");

    const trustedRename = await runMutation(runtime.database, signedUp.data.auth, "renameAdditionalTeam", [trustedCreate.data.team.id, "Trusted Renamed Team"]);
    assert.equal(trustedRename.error, null, JSON.stringify(trustedRename.error));
    assert.equal(trustedRename.data.team.name, "Trusted Renamed Team");

    const renamedOverBrowser = await send(owner, {
      id: "additional-rename",
      type: "teams.rename",
      teamId: created.data.team.id,
      name: "  Platform Team  ",
    });
    assert.equal(renamedOverBrowser.error, null, JSON.stringify(renamedOverBrowser.error));
    assert.equal(renamedOverBrowser.data.team.name, "Platform Team");

    const auditEvents = (await runtime.database.log.tail(20)).filter((event) => event.event.startsWith("teams."));
    assert.deepEqual(auditEvents.map((event) => event.event), ["teams.created", "teams.created", "teams.created", "teams.renamed", "teams.renamed"]);
    assert.deepEqual(auditEvents.map((event) => [event.data.operation, event.data.outcome, event.data.code]), [
      ["teams.create", "succeeded", "TEAM_CREATED"], ["teams.create", "succeeded", "TEAM_CREATED"], ["teams.create", "succeeded", "TEAM_CREATED"],
      ["teams.rename", "succeeded", "TEAM_RENAMED"], ["teams.rename", "succeeded", "TEAM_RENAMED"],
    ]);
    assert.doesNotMatch(JSON.stringify(auditEvents), /Product Team|Platform Team|sessionToken|provider/);

    stranger = await runtime.open();
    const strangerSignUp = await send(stranger, {
      id: "additional-stranger-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "additional-stranger@example.com", password: "password-123", name: "Additional Stranger" },
    });
    assert.equal(strangerSignUp.error, null, JSON.stringify(strangerSignUp.error));
    await runtime.database.adapter.prepare(runtime.database.adapter.dialect.sql(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)",
    )).run(created.data.team.id, strangerSignUp.data.auth.userId, new Date().toISOString());
    const denied = await send(stranger, {
      id: "additional-stranger-rename",
      type: "teams.rename",
      teamId: created.data.team.id,
      name: "Leaked name",
    });
    assert.equal(denied.error.code, "DENIED");
    assert.equal(denied.error.message, "Team operation denied.");
    assert.doesNotMatch(JSON.stringify(denied), /Product Team|Platform Team|additional-owner/);
    const denialAuditCount = (await runtime.database.log.tail(20)).filter((event) => event.event === "teams.rename" && event.data.outcome === "denied").length;
    const trustedDenied = await runMutation(runtime.database, strangerSignUp.data.auth, "renameAdditionalTeam", [created.data.team.id, "Still denied"]);
    assert.equal(trustedDenied.ok, false);
    assert.equal(trustedDenied.error.code, "DENIED");
    assert.equal((await runtime.database.log.tail(20)).filter((event) => event.event === "teams.rename" && event.data.outcome === "denied").length, denialAuditCount + 1);
    const malformed = await send(stranger, { id: "additional-malformed-rename", type: "teams.rename", teamId: { id: created.data.team.id }, name: "Nope" });
    assert.equal(malformed.error.code, "DENIED");
    const deniedAudit = (await runtime.database.log.tail(20)).find((event) => event.event === "teams.rename" && event.data.outcome === "denied");
    assert.deepEqual([deniedAudit.data.operation, deniedAudit.data.outcome, deniedAudit.data.code], ["teams.rename", "denied", "DENIED"]);

    owner.close(); owner = null;
    stranger.close(); stranger = null;
    await runtime.close();
    runtime = await startRuntime(databasePath);
    owner = await runtime.open();
    const afterRestart = await send(owner, { id: "additional-after-restart", type: "teams.list", sessionToken: signedUp.data.sessionToken });
    assert.equal(afterRestart.error, null, JSON.stringify(afterRestart.error));
    assert.deepEqual(new Set(afterRestart.data.teams.map((team) => team.name)), new Set(["My Team", "Platform Team", "a".repeat(80), "Trusted Renamed Team"]));
  } finally {
    owner?.close(); stranger?.close();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Team admins create, inspect, list, and revoke email-bound Join links without exposing a capability", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-join-links-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let stranger;
  try {
    owner = await runtime.open();
    stranger = await runtime.open();
    const ownerSignUp = await signUp(owner, "join-owner-signup", "join-owner@example.com", "Join Owner");
    const strangerSignUp = await signUp(stranger, "join-stranger-signup", "join-stranger@example.com", "Join Stranger");
    const ownerTeams = await send(owner, { id: "join-owner-teams", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken });
    const teamId = ownerTeams.data.teams[0].id;

    const created = await send(owner, {
      id: "join-create",
      type: "teams.createJoinLink",
      teamId,
      email: "  Recipient@Example.com  ",
      ttlSeconds: 3600,
    });
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.equal(created.type, "teams.createJoinLink.result");
    const url = new URL(created.data.link);
    assert.equal(url.origin, "http://localhost:4000", "the configured Capsule origin, not a request header, owns the link");
    assert.equal(url.pathname, "/join");
    const code = url.searchParams.get("code");
    assert.match(code, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const inspected = await send(stranger, { id: "join-inspect", type: "teams.inspectJoinLink", code });
    assert.deepEqual(Object.keys(inspected.data).sort(), ["expiresAt", "team", "usable"]);
    assert.equal(inspected.data.usable, true);
    assert.equal(inspected.data.team.id, teamId);
    assertNoTeamLeak(inspected.data, ["Recipient@Example.com", "recipient@example.com", ownerSignUp.data.auth.userId]);

    const listed = await send(owner, { id: "join-list", type: "teams.listJoinLinks", teamId });
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.deepEqual(listed.data.links, [{
      id: created.data.id,
      email: "recipient@example.com",
      createdAt: created.data.createdAt,
      expiresAt: created.data.expiresAt,
    }]);
    assertNoTeamLeak(listed.data, [code, created.data.link]);

    const denied = await send(stranger, { id: "join-cross-team-revoke", type: "teams.revokeJoinLink", teamId, joinLinkId: created.data.id, sessionToken: strangerSignUp.data.sessionToken });
    assert.equal(denied.error.code, "DENIED");
    const revoked = await send(owner, { id: "join-revoke", type: "teams.revokeJoinLink", teamId, joinLinkId: created.data.id });
    assert.equal(revoked.error, null, JSON.stringify(revoked.error));
    assert.deepEqual(revoked.data, { revoked: true });
    const afterRevoke = await send(stranger, { id: "join-reinspect", type: "teams.inspectJoinLink", code });
    assert.deepEqual(afterRevoke.data, { team: null, expiresAt: null, usable: false });
  } finally {
    owner?.close(); stranger?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted endpoint and app-message Team rename denials emit one redacted audit each", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-trusted-denials-"));
  const databasePath = path.join(dir, "data.db");
  const runtime = await startRuntime(databasePath);
  let owner;
  let stranger;
  try {
    owner = await runtime.open();
    const ownerSignUp = await send(owner, {
      id: "trusted-denial-owner-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "owner-private@example.com", password: "password-123", name: "Owner Private" },
    });
    assert.equal(ownerSignUp.error, null, JSON.stringify(ownerSignUp.error));
    const created = await send(owner, { id: "trusted-denial-create", type: "teams.create", name: "Top Secret Team" });
    assert.equal(created.error, null, JSON.stringify(created.error));

    stranger = await runtime.open();
    const strangerSignUp = await send(stranger, {
      id: "trusted-denial-stranger-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "stranger-private@example.com", password: "password-123", name: "Stranger Private" },
    });
    assert.equal(strangerSignUp.error, null, JSON.stringify(strangerSignUp.error));
    runtime.database.messages = [{
      name: "renameAdditionalTeam",
      handlerSource: "(ctx, data) => ctx.teams.rename(data.teamId, data.name)",
    }];

    const beforeEndpoint = await deniedRenameAudits(runtime.database);
    const endpointResponse = await fetch(`${runtime.baseUrl}/teams/rename`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sporades-session-token": strangerSignUp.data.sessionToken,
      },
      body: JSON.stringify({ teamId: created.data.team.id, name: "Attempted endpoint rename" }),
    });
    assert.equal(endpointResponse.status, 500, "endpoint handler denials follow the existing generic endpoint-error status policy");
    const endpointDenied = await endpointResponse.json();
    assert.deepEqual(endpointDenied.error, {
      code: "DENIED",
      message: "Team operation denied.",
      hint: "Sign in with a Team administrator account and retry.",
    });
    assertNoTeamLeak(endpointDenied, [
      "Top Secret Team", "Attempted endpoint rename", ownerSignUp.data.sessionToken, strangerSignUp.data.sessionToken,
      "owner-private@example.com", "stranger-private@example.com", "provider",
    ]);
    const endpointAudits = await deniedRenameAudits(runtime.database);
    assert.equal(endpointAudits.length, beforeEndpoint.length + 1);
    assertRedactedDeniedRenameAudit(endpointAudits.at(-1), created.data.team.id, strangerSignUp.data.auth.userId, [
      "Top Secret Team", "Attempted endpoint rename", ownerSignUp.data.sessionToken, strangerSignUp.data.sessionToken,
      "owner-private@example.com", "stranger-private@example.com", "provider",
    ]);

    const beforeMessage = await deniedRenameAudits(runtime.database);
    const messageDenied = await send(stranger, {
      id: "trusted-denial-message",
      type: "app.send",
      message: "renameAdditionalTeam",
      data: { teamId: created.data.team.id, name: "Attempted message rename" },
    });
    assert.equal(messageDenied.type, "app.result");
    assert.equal(messageDenied.error.code, "DENIED", JSON.stringify(messageDenied));
    assert.equal(messageDenied.error.message, "Team operation denied.");
    assertNoTeamLeak(messageDenied, [
      "Top Secret Team", "Attempted message rename", ownerSignUp.data.sessionToken, strangerSignUp.data.sessionToken,
      "owner-private@example.com", "stranger-private@example.com", "provider",
    ]);
    const messageAudits = await deniedRenameAudits(runtime.database);
    assert.equal(messageAudits.length, beforeMessage.length + 1);
    assertRedactedDeniedRenameAudit(messageAudits.at(-1), created.data.team.id, strangerSignUp.data.auth.userId, [
      "Top Secret Team", "Attempted message rename", ownerSignUp.data.sessionToken, strangerSignUp.data.sessionToken,
      "owner-private@example.com", "stranger-private@example.com", "provider",
    ]);

    const persisted = runtime.database.adapter.prepare("SELECT [name] FROM [sporades_teams] WHERE [id] = ?").get(created.data.team.id);
    assert.equal(persisted.name, "Top Secret Team", "denials must leave the existing Team unchanged");
  } finally {
    owner?.close(); stranger?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("additional Team creation is atomic and bounded across the trusted server interface", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-atomic-"));
  const databasePath = path.join(dir, "data.db");
  const runtime = await startRuntime(databasePath);
  const auth = { userId: "team-atomic-user", displayName: "Atomic", email: "atomic@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
  const baseAdapter = runtime.database.adapter;
  try {
    await baseAdapter.withTransaction((tx) => tx.linkAuthUser({
      id: auth.userId, displayName: auth.displayName, email: auth.email, picture: null,
      isAuthenticated: 1, isGuest: 0, provider: "email",
    }));
    runtime.database.mutationHooks.afterMutation = ["() => { throw new Error('post-create rollback'); }"];
    const rolledBack = await runMutation(runtime.database, auth, "createAdditionalTeam", ["Will Roll Back"]);
    assert.equal(rolledBack.ok, false);
    assert.equal(countTeams(baseAdapter), 0, "a failed Team mutation leaves no orphan Team");
    assert.equal(countMemberships(baseAdapter), 0);
    assert.equal((await runtime.database.log.tail(20)).some((event) => event.event === "teams.created"), false, "rolled-back creation emits no success audit");

    runtime.database.mutationHooks.afterMutation = [];
    for (let index = 0; index < 24; index += 1) {
      const created = await runMutation(runtime.database, auth, "createAdditionalTeam", [`Bounded Team ${index + 1}`]);
      assert.equal(created.ok, true, JSON.stringify(created));
    }
    const overLimit = await runMutation(runtime.database, auth, "createAdditionalTeam", ["One Team Too Many"]);
    assert.equal(overLimit.ok, false);
    assert.equal(overLimit.error.code, "TEAM_LIMIT_REACHED");
    assert.equal(countTeams(baseAdapter), 25);
    assert.equal(countMemberships(baseAdapter), 25);
    const listed = await runQuery(runtime.database, auth, "ownTeams");
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(listed.data.teams.length, 25);
  } finally {
    runtime.database.mutationHooks.afterMutation = [];
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the durable Team membership claim holds the limit across concurrent runtimes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-cross-runtime-"));
  const databasePath = path.join(dir, "data.db");
  const first = await openDevDatabase(databasePath, "", {}, { name: "teams-cross-runtime", auth: { providers: { anonymous: true, email: true } } }, capsule);
  const second = await openDevDatabase(databasePath, "", {}, { name: "teams-cross-runtime", auth: { providers: { anonymous: true, email: true } } }, capsule);
  const auth = { userId: "team-cross-runtime-user", displayName: "Cross runtime", email: "cross-runtime@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
  try {
    await first.adapter.withTransaction((tx) => tx.linkAuthUser({
      id: auth.userId, displayName: auth.displayName, email: auth.email, picture: null,
      isAuthenticated: 1, isGuest: 0, provider: "email",
    }));
    for (let index = 0; index < 23; index += 1) await createAdditionalTeam(first, auth, `Concurrent Team ${index + 1}`);
    const results = await Promise.allSettled([
      createAdditionalTeam(first, auth, "Concurrent winner one"),
      createAdditionalTeam(second, auth, "Concurrent winner two"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "TEAM_LIMIT_REACHED");
    assert.equal(countMemberships(first.adapter), 25);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a committed Team audit flushes before a later pending Job enqueue failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-audit-flush-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  const auth = { userId: "team-audit-user", displayName: "Audit", email: "audit@example.com", picture: "https://example.com/audit.png", isAuthenticated: true, isGuest: false, provider: "email" };
  const baseAdapter = runtime.database.adapter;
  try {
    await baseAdapter.withTransaction((tx) => tx.linkAuthUser({ id: auth.userId, displayName: auth.displayName, email: auth.email, picture: auth.picture, isAuthenticated: 1, isGuest: 0, provider: auth.provider }));
    runtime.database.adapter = failPendingJobInsert(baseAdapter);
    const result = await runMutation(runtime.database, auth, "createAndQueue", ["Committed before queue failure"]);
    assert.equal(result.ok, false);
    assert.equal(countTeams(baseAdapter), 2, "the initial and additional Teams committed before the Job failure");
    assert.equal((await runtime.database.log.tail(20)).filter((event) => event.event === "teams.created").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    runtime.database.adapter = baseAdapter;
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function startRuntime(databasePath) {
  const database = await openDevDatabase(databasePath, "", {}, {
    name: "teams-test",
    auth: { providers: { anonymous: true, email: true } },
  }, capsule);
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("request", async (request, response) => {
    if (!await routeEndpoint(database, request, response)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    database,
    baseUrl: `http://127.0.0.1:${port}`,
    open: () => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?connectionToken=${hub.createConnectionToken()}`);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", reject, { once: true });
    }),
    async close() {
      hub.disconnectAll();
      await new Promise((resolve) => server.close(resolve));
      await database.close();
    },
  };
}

async function deniedRenameAudits(database) {
  return (await database.log.tail(100)).filter((event) => event.event === "teams.rename" && event.data.outcome === "denied");
}

function assertRedactedDeniedRenameAudit(event, teamId, actorUserId, forbidden) {
  assert.deepEqual(event.data, {
    operation: "teams.rename",
    outcome: "denied",
    code: "DENIED",
    actorUserId,
    teamId,
  });
  assertNoTeamLeak(event, forbidden);
}

function assertNoTeamLeak(value, forbidden) {
  const serialized = JSON.stringify(value);
  for (const item of forbidden) assert.doesNotMatch(serialized, new RegExp(escapeRegExp(item), "i"));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function send(ws, message) {
  return new Promise((resolve) => {
    const listener = ({ data }) => {
      const response = JSON.parse(data);
      if (response.id !== message.id) return;
      ws.removeEventListener("message", listener);
      resolve(response);
    };
    ws.addEventListener("message", listener);
    ws.send(JSON.stringify(message));
  });
}

async function signUp(ws, id, email, name) {
  const result = await send(ws, {
    id,
    type: "auth.signUp",
    provider: "email",
    credentials: { email, password: "password-123", name },
  });
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result;
}

function countTeams(adapter) {
  return Number(adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams]").get().count);
}

function countMemberships(adapter) {
  return Number(adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships]").get().count);
}

function failPendingJobInsert(adapter) {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "prepare" || typeof value !== "function") return value;
      return (statement) => {
        const prepared = value.call(target, statement);
        const text = String(statement?.text ?? statement);
        if (!text.includes("INSERT INTO") || !text.includes("sporades_jobs")) return prepared;
        return { ...prepared, run() { throw new Error("pending Job insert failed"); } };
      };
    },
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  linkProviderIdentity, openDevDatabase, resolveAnonymousSession, runMutation, runQuery, signInWithEmail, signUpWithEmail, simulateLocalIdentitySession,
} from "../dist/server-runtime-source.js";
import { createAdditionalTeam, createTeamJoinLink, createTeamTables, deleteCurrentUserTeam, demoteTeamMember, inspectTeamJoinLink, joinCurrentUserTeam, leaveCurrentUserTeam, listCurrentUserTeams, listTeamJoinLinks, listTeamMembers, promoteTeamMember, removeTeamMember, revokeTeamJoinLink, updateTeamMemberApplicationRoles } from "../dist/teams-runtime.js";
import { mutation, String, table } from "../dist/server.js";
import { createPendingFileUpload } from "../dist/file-storage-runtime.js";

test("Capsules cannot adopt runtime-owned Team tables through ctx.db schema", async () => {
  await withDatabase(async (databasePath) => {
    await assert.rejects(
      () => openDevDatabase(databasePath, "", {}, { name: "teams-isolation" }, {
        name: "teams-isolation",
        schema: { sporades_teams: table({ leaked: String() }) },
      }),
      (error) => error?.code === "RESERVED_TABLE_NAME",
    );
  });
});

test("Capsules cannot bypass the complete runtime Team namespace with case or future names", async () => {
  for (const name of ["SPORADES_TEAMS", "SPORADES_TEAM_BOOTSTRAP", "sporades_teamfuture"]) {
    await withDatabase(async (databasePath) => {
      await assert.rejects(
        () => openDevDatabase(databasePath, "", {}, { name: "teams-isolation" }, {
          name: "teams-isolation",
          schema: { [name]: table({ leaked: String() }) },
        }),
        (error) => error?.code === "RESERVED_TABLE_NAME",
        name,
      );
    });
  }
});

test("Team runtime DDL runs in deterministic table order", async () => {
  const calls = [];
  let releaseFirst;
  const adapter = {
    dialect: { sql: (statement) => statement },
    exec(statement) {
      calls.push(statement);
      if (calls.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    },
  };
  const created = createTeamTables(adapter);
  assert.equal(calls.length, 1, "the second DDL statement waits for the first");
  releaseFirst();
  await created;
  assert.equal(calls.length, 10);
  assert.match(calls[0], /sporades_teams/);
  assert.match(calls[1], /sporades_team_memberships/);
  assert.match(calls[2], /sporades_team_membership_application_roles/);
  assert.match(calls[3], /sporades_team_bootstrap/);
  assert.match(calls[4], /sporades_team_membership_counters/);
  assert.match(calls[5], /sporades_team_join_link_secrets/);
  assert.match(calls[6], /sporades_team_join_links/);
  assert.match(calls[7], /sporades_team_join_link_throttles/);
  assert.match(calls[8], /sporades_team_join_link_counters/);
  assert.match(calls[9], /sporades_team_join_link_redemptions/);
});

test("Team role declarations validate at Capsule load and retained assignments fail closed until reintroduced", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "team-role-declaration", auth: { providers: { anonymous: true, email: true } } };
    for (const appRoles of [["admin"], ["member"], ["sporades-owner"], ["Author"], ["author", "author"], Array.from({ length: 33 }, (_, index) => `role-${index}`)]) {
      await assert.rejects(
        () => openDevDatabase(databasePath, "", {}, config, { name: "bad-roles", teams: { appRoles }, schema: {} }),
        (error) => error?.code === "INVALID_TEAM_APPLICATION_ROLES",
      );
    }
    let database = await openDevDatabase(databasePath, "", {}, config, { name: "declared-roles", teams: { appRoles: ["author"] }, schema: {} });
    const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "declared-owner@example.com", password: "password-123", name: "Owner" });
    const member = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "declared-member@example.com", password: "password-123", name: "Member" });
    const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
    await database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(team.id, member.auth.userId, new Date().toISOString());
    await updateTeamMemberApplicationRoles(database, owner.auth, team.id, member.auth.userId, { add: ["author"], remove: [] });
    assert.deepEqual((await listTeamMembers(database, owner.auth, team.id)).members.find((entry) => entry.userId === member.auth.userId).applicationRoles, ["author"]);
    const audit = (await database.log.tail(10)).find((event) => event.event === "teams.applicationRolesUpdated");
    assert.deepEqual(audit.data, { operation: "teams.updateApplicationRoles", outcome: "succeeded", code: "TEAM_APPLICATION_ROLES_UPDATED", actorUserId: owner.auth.userId, teamId: team.id, targetUserId: member.auth.userId, add: ["author"], remove: [] });
    assertNoTeamAuditLeak(audit, ["declared-owner@example.com", "declared-member@example.com", "password", "session"]);
    await database.close();
    database = await openDevDatabase(databasePath, "", {}, config, { name: "undeclared-roles", schema: {} });
    assert.deepEqual((await listTeamMembers(database, owner.auth, team.id)).members.find((entry) => entry.userId === member.auth.userId).applicationRoles, [], "removed declaration immediately deactivates its retained row");
    await database.close();
    database = await openDevDatabase(databasePath, "", {}, config, { name: "restored-roles", teams: { appRoles: ["author"] }, schema: {} });
    assert.deepEqual((await listTeamMembers(database, owner.auth, team.id)).members.find((entry) => entry.userId === member.auth.userId).applicationRoles, ["author"], "reintroduction restores the retained assignment without migration");
    await database.close();
  });
});

test("membership removal, leave, and eligible Team deletion clear active and inactive application-role rows", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "team-role-cleanup", auth: { providers: { anonymous: true, email: true } } };
    const database = await openDevDatabase(databasePath, "", {}, config, { name: "team-role-cleanup", teams: { appRoles: ["author"] }, schema: {} });
    try {
      const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "cleanup-owner@example.com", password: "password-123", name: "Owner" });
      const removedUser = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "cleanup-removed@example.com", password: "password-123", name: "Removed" });
      const leavingUser = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "cleanup-leaving@example.com", password: "password-123", name: "Leaving" });
      const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
      const now = new Date().toISOString();
      for (const user of [removedUser, leavingUser]) {
        await database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(team.id, user.auth.userId, now);
        for (const role of ["author", "retired-role"]) await database.adapter.prepare("INSERT INTO [sporades_team_membership_application_roles] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)").run(team.id, user.auth.userId, role, now);
      }

      await removeTeamMember(database, owner.auth, team.id, removedUser.auth.userId);
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_membership_application_roles] WHERE [teamId] = ? AND [userId] = ?").get(team.id, removedUser.auth.userId).count, 0, "remove clears both declared and inactive role rows");
      await leaveCurrentUserTeam(database, leavingUser.auth, team.id);
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_membership_application_roles] WHERE [teamId] = ? AND [userId] = ?").get(team.id, leavingUser.auth.userId).count, 0, "leave clears both declared and inactive role rows");

      const deletable = (await createAdditionalTeam(database, owner.auth, "Role cleanup deletion")).team;
      for (const role of ["author", "retired-role"]) await database.adapter.prepare("INSERT INTO [sporades_team_membership_application_roles] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)").run(deletable.id, owner.auth.userId, role, now);
      await deleteCurrentUserTeam(database, owner.auth, deletable.id);
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_membership_application_roles] WHERE [teamId] = ?").get(deletable.id).count, 0, "eligible deletion clears all active and inactive role rows");
    } finally {
      await database.close();
    }
  });
});

test("a failed role write rolls the complete mixed add/remove update back", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "team-role-write-rollback", auth: { providers: { anonymous: true, email: true } } };
    const database = await openDevDatabase(databasePath, "", {}, config, { name: "team-role-write-rollback", teams: { appRoles: ["author", "reviewer"] }, schema: {} });
    const baseAdapter = database.adapter;
    try {
      const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "rollback-role-owner@example.com", password: "password-123", name: "Owner" });
      const member = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "rollback-role-member@example.com", password: "password-123", name: "Member" });
      const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
      await baseAdapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(team.id, member.auth.userId, new Date().toISOString());
      await updateTeamMemberApplicationRoles(database, owner.auth, team.id, member.auth.userId, { add: ["author"], remove: [] });

      database.adapter = failTeamApplicationRoleInsert(baseAdapter, new Error("role insert exploded"));
      await assert.rejects(
        () => updateTeamMemberApplicationRoles(database, owner.auth, team.id, member.auth.userId, { add: ["reviewer"], remove: ["author"] }),
        /role insert exploded/,
      );
      database.adapter = baseAdapter;
      assert.deepEqual((await listTeamMembers(database, owner.auth, team.id)).members.find((entry) => entry.userId === member.auth.userId).applicationRoles, ["author"], "the earlier removal is rolled back with the failed insert");
    } finally {
      database.adapter = baseAdapter;
      await database.close();
    }
  });
});

test("Join-link capacity and admin throttle admit only their final guarded slots across concurrent runtime adapters", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-join-claims-"));
  const databasePath = path.join(dir, "data.db");
  const config = { name: "join-claims", auth: { providers: { anonymous: true, email: true } } };
  const first = await openDevDatabase(databasePath, "", {}, config, { name: "join-claims", schema: {} });
  const second = await openDevDatabase(databasePath, "", {}, config, { name: "join-claims", schema: {} });
  try {
    const session = await resolveAnonymousSession(first, null);
    const linked = await signUpWithEmail(first, session, "email", { email: "claims-owner@example.com", password: "password-123", name: "Owner" });
    const team = (await listCurrentUserTeams(first, linked.auth)).teams[0];
    const admins = [linked.auth];
    for (const index of [1, 2]) {
      const extraSession = await resolveAnonymousSession(first, null);
      const extra = await signUpWithEmail(first, extraSession, "email", { email: `claims-admin-${index}@example.com`, password: "password-123", name: `Admin ${index}` });
      admins.push(extra.auth);
      await first.adapter.prepare(first.adapter.dialect.sql(
        "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)",
      )).run(team.id, extra.auth.userId, new Date().toISOString());
    }
    const attempts = await Promise.all(Array.from({ length: 21 }, (_, index) =>
      createTeamJoinLink(index % 2 ? first : second, admins[index % admins.length], team.id, `capacity-${index}@example.com`, { ttlSeconds: 300 })
        .then(() => "created", (error) => error.code),
    ));
    assert.equal(attempts.filter((result) => result === "created").length, 20);
    assert.deepEqual(attempts.filter((result) => result !== "created"), ["JOIN_LINK_LIMIT_REACHED"]);
    assert.equal(first.adapter.prepare("SELECT [activeCount] FROM [sporades_team_join_link_counters] WHERE [teamId] = ?").get(team.id).activeCount, 20);

    const secondTeam = await first.adapter.withTransaction(async (tx) => {
      const id = "1b7d53ea-9f5c-4a61-bd13-a43dc489b811";
      const now = new Date().toISOString();
      await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run(id, "Throttle", now, linked.auth.userId);
      await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(id, linked.auth.userId, now);
      return id;
    });
    const throttled = await Promise.all(Array.from({ length: 11 }, (_, index) =>
      createTeamJoinLink(index % 2 ? first : second, linked.auth, secondTeam, `throttle-${index}@example.com`, { ttlSeconds: 300 })
        .then(() => "created", (error) => error.code),
    ));
    assert.equal(throttled.filter((result) => result === "created").length, 10);
    assert.deepEqual(throttled.filter((result) => result !== "created"), ["JOIN_LINK_THROTTLED"]);
  } finally {
    await second.close(); await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete and Join-link writers share a Team lifecycle lock across runtime adapters", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-delete-join-lock-"));
  const databasePath = path.join(dir, "data.db");
  const config = { name: "delete-join-lock", auth: { providers: { anonymous: true, email: true } } };
  const ownerRuntime = await openDevDatabase(databasePath, "", {}, config, { name: "delete-join-lock", schema: {} });
  const recipientRuntime = await openDevDatabase(databasePath, "", {}, config, { name: "delete-join-lock", schema: {} });
  try {
    const owner = await signUpWithEmail(ownerRuntime, await resolveAnonymousSession(ownerRuntime, null), "email", {
      email: "delete-lock-owner@example.com", password: "password-123", name: "Owner",
    });
    const recipient = await signUpWithEmail(ownerRuntime, await resolveAnonymousSession(ownerRuntime, null), "email", {
      email: "delete-lock-recipient@example.com", password: "password-123", name: "Recipient",
    });
    const team = (await listCurrentUserTeams(ownerRuntime, owner.auth)).teams[0];
    const issued = await createTeamJoinLink(ownerRuntime, owner.auth, team.id, "delete-lock-recipient@example.com", { ttlSeconds: 300 });
    const code = new URL(issued.link).searchParams.get("code");

    // Start both mutations together against independent runtime adapters. The
    // database must linearize them: either joining makes deletion ineligible,
    // or deletion makes the stale capability unusable. Neither result may
    // leave a Team-scoped row pointing at a deleted Team.
    const results = await Promise.allSettled([
      deleteCurrentUserTeam(ownerRuntime, owner.auth, team.id),
      joinCurrentUserTeam(recipientRuntime, recipient.auth, code),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(ownerRuntime.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] [m] LEFT JOIN [sporades_teams] [t] ON [t].[id] = [m].[teamId] WHERE [t].[id] IS NULL",
    ).get().count, 0, "no orphan membership survives the race");
    assert.equal(ownerRuntime.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_redemptions] [r] LEFT JOIN [sporades_team_join_links] [l] ON [l].[id] = [r].[joinLinkId] WHERE [l].[id] IS NULL",
    ).get().count, 0, "no orphan redemption survives the race");
    assert.equal(ownerRuntime.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_counters] [c] LEFT JOIN [sporades_teams] [t] ON [t].[id] = [c].[teamId] WHERE [t].[id] IS NULL",
    ).get().count, 0, "no orphan link counter survives the race");
  } finally {
    await Promise.all([ownerRuntime.close(), recipientRuntime.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Join-link issue, revoke, and redemption acquire the Team lifecycle lock before their mutable state", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "team-join-lifecycle-seam", auth: { providers: { anonymous: true, email: true } },
    }, { name: "team-join-lifecycle-seam", schema: {} });
    const baseAdapter = database.adapter;
    try {
      const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", {
        email: "join-lifecycle-owner@example.com", password: "password-123", name: "Owner",
      });
      const recipient = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", {
        email: "join-lifecycle-recipient@example.com", password: "password-123", name: "Recipient",
      });
      const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
      const statements = [];
      database.adapter = recordTeamStatements(baseAdapter, statements);

      const issued = await createTeamJoinLink(database, owner.auth, team.id, "join-lifecycle-recipient@example.com", { ttlSeconds: 300 });
      assertLifecycleLockPrecedes(statements, "INSERT INTO sporades_team_join_links", "issue");

      statements.length = 0;
      await revokeTeamJoinLink(database, owner.auth, team.id, issued.id);
      assertLifecycleLockPrecedes(statements, "UPDATE sporades_team_join_links SET revokedAt", "revoke");

      statements.length = 0;
      const redeemable = await createTeamJoinLink(database, owner.auth, team.id, "join-lifecycle-recipient@example.com", { ttlSeconds: 300 });
      statements.length = 0;
      await joinCurrentUserTeam(database, recipient.auth, new URL(redeemable.link).searchParams.get("code"));
      assertLifecycleLockPrecedes(statements, "UPDATE sporades_team_join_links SET consumedAt", "redemption");
      const linkReads = statements.filter((statement) => normalizedSql(statement).includes("SELECT id, selector, verifierHash, teamId, email, expiresAt, consumedAt, revokedAt FROM sporades_team_join_links"));
      assert.equal(linkReads.length, 2, "redemption re-reads its grant after claiming the Team lock");
    } finally {
      database.adapter = baseAdapter;
      await database.close();
    }
  });
});

test("concurrent demote and remove operations retain one committed Team admin", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "team-admin-lifecycle-race", auth: { providers: { anonymous: true, email: true } },
    }, { name: "team-admin-lifecycle-race", schema: {} });
    try {
      const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", {
        email: "race-owner@example.com", password: "password-123", name: "Owner",
      });
      const otherAdmin = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", {
        email: "race-admin@example.com", password: "password-123", name: "Other admin",
      });
      const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
      const issued = await createTeamJoinLink(database, owner.auth, team.id, "race-admin@example.com", { ttlSeconds: 300 });
      await joinCurrentUserTeam(database, otherAdmin.auth, new URL(issued.link).searchParams.get("code"));
      await promoteTeamMember(database, owner.auth, team.id, otherAdmin.auth.userId);

      // Both calls see two admins before entering the transaction. The shared
      // lifecycle lock, not a preflight count, decides which can commit.
      const results = await Promise.allSettled([
        demoteTeamMember(database, owner.auth, team.id, otherAdmin.auth.userId),
        removeTeamMember(database, otherAdmin.auth, team.id, owner.auth.userId),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(database.adapter.prepare(
        "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [role] = 'admin'",
      ).get(team.id).count, 1, "the surviving Team retains its only committed admin");
    } finally {
      await database.close();
    }
  });
});

test("Join-link inspection rejects tampering, expiry, and revocation without recovering stored capability material", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, { name: "join-inspection", auth: { providers: { anonymous: true, email: true } } }, { name: "join-inspection", schema: {} });
    try {
      const session = await resolveAnonymousSession(database, null);
      const linked = await signUpWithEmail(database, session, "email", { email: "inspect-owner@example.com", password: "password-123", name: "Owner" });
      const team = (await listCurrentUserTeams(database, linked.auth)).teams[0];
      const created = await createTeamJoinLink(database, linked.auth, team.id, "recipient@example.com", { ttlSeconds: 300 });
      const code = new URL(created.link).searchParams.get("code");
      assert.equal((await inspectTeamJoinLink(database, `${code}x`)).usable, false, "HMAC tampering is invalid");
      const stored = database.adapter.prepare("SELECT * FROM [sporades_team_join_links] WHERE [id] = ?").get(created.id);
      assert.equal("code" in stored, false);
      assert.equal("link" in stored, false);
      assert.doesNotMatch(JSON.stringify(stored), new RegExp(code, "i"));
      await revokeTeamJoinLink(database, linked.auth, team.id, created.id);
      assert.equal((await inspectTeamJoinLink(database, code)).usable, false, "revocation invalidates inspection");
    } finally { await database.close(); }
  });
});

test("target-Team expiry reconciliation frees capacity even when the global bounded prune is exhausted elsewhere", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, { name: "join-target-reconcile", auth: { providers: { anonymous: true, email: true } } }, { name: "join-target-reconcile", schema: {} });
    try {
      const session = await resolveAnonymousSession(database, null);
      const linked = await signUpWithEmail(database, session, "email", { email: "reconcile-owner@example.com", password: "password-123", name: "Owner" });
      const team = (await listCurrentUserTeams(database, linked.auth)).teams[0];
      const sql = database.adapter.dialect.sql;
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      for (let index = 0; index < 100; index += 1) {
        await database.adapter.prepare(sql("INSERT INTO [sporades_team_join_links] ([id], [selector], [verifierHash], [teamId], [email], [createdByUserId], [createdAt], [expiresAt], [consumedAt], [revokedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")).run(`other-expired-${index}`, `other-selector-${index}`, "hash", `other-team-${index}`, `other-${index}@example.com`, linked.auth.userId, expiredAt, expiredAt);
      }
      for (let index = 0; index < 20; index += 1) {
        await database.adapter.prepare(sql("INSERT INTO [sporades_team_join_links] ([id], [selector], [verifierHash], [teamId], [email], [createdByUserId], [createdAt], [expiresAt], [consumedAt], [revokedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")).run(`target-expired-${index}`, `target-selector-${index}`, "hash", team.id, `target-${index}@example.com`, linked.auth.userId, expiredAt, expiredAt);
      }
      await database.adapter.prepare(sql("INSERT INTO [sporades_team_join_link_redemptions] ([joinLinkId], [teamId], [userId], [createdAt]) VALUES (?, ?, ?, ?)")).run("target-expired-0", team.id, linked.auth.userId, expiredAt);
      await database.adapter.prepare(sql("INSERT INTO [sporades_team_join_link_counters] ([teamId], [activeCount]) VALUES (?, ?)")).run(team.id, 20);

      const created = await createTeamJoinLink(database, linked.auth, team.id, "live@example.com", { ttlSeconds: 300 });
      assert.ok(created.link, "target expiration must not leave its capacity counter pinned at 20");
      assert.equal(database.adapter.prepare(sql("SELECT [activeCount] FROM [sporades_team_join_link_counters] WHERE [teamId] = ?")).get(team.id).activeCount, 1);
      assert.equal(database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_redemptions] WHERE [teamId] = ?")).get(team.id).count, 0, "target reconciliation removes expired redemption ownership with its grants");
    } finally { await database.close(); }
  });
});

test("global Join-link expiry pruning removes redemption ownership with its grant", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, { name: "join-global-prune-redemptions", auth: { providers: { anonymous: true, email: true } } }, { name: "join-global-prune-redemptions", schema: {} });
    try {
      const linked = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "global-prune-owner@example.com", password: "password-123", name: "Owner" });
      const team = (await listCurrentUserTeams(database, linked.auth)).teams[0];
      const sql = database.adapter.dialect.sql;
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      await database.adapter.prepare(sql("INSERT INTO [sporades_team_join_links] ([id], [selector], [verifierHash], [teamId], [email], [createdByUserId], [createdAt], [expiresAt], [consumedAt], [revokedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")).run("expired-redeemed-link", "expired-redeemed-selector", "hash", team.id, "recipient@example.com", linked.auth.userId, expiredAt, expiredAt, expiredAt);
      await database.adapter.prepare(sql("INSERT INTO [sporades_team_join_link_redemptions] ([joinLinkId], [teamId], [userId], [createdAt]) VALUES (?, ?, ?, ?)")).run("expired-redeemed-link", team.id, linked.auth.userId, expiredAt);

      assert.deepEqual(await listTeamJoinLinks(database, linked.auth, team.id), { links: [] });
      assert.equal(database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_join_links] WHERE [id] = ?")).get("expired-redeemed-link").count, 0);
      assert.equal(database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_redemptions] WHERE [joinLinkId] = ?")).get("expired-redeemed-link").count, 0);
    } finally { await database.close(); }
  });
});

test("concurrent initial Team listing shares one SQLite bootstrap transaction", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-concurrency",
      auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-concurrency", schema: {} });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      const linked = await signUpWithEmail(database, anonymous, "email", {
        email: "owner@example.com", password: "password-123", name: "Owner",
      });
      assert.equal(
        database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [createdByUserId] = ?").get(linked.auth.userId).count,
        1,
        "email account linking commits the initial Team before a Team-interface call",
      );
      const results = await Promise.all([
        listCurrentUserTeams(database, linked.auth),
        listCurrentUserTeams(database, linked.auth),
      ]);
      assert.equal(results[0].teams.length, 1);
      assert.deepEqual(results[0], results[1]);
    } finally {
      await database.close();
    }
  });
});

test("a new email link and a legacy Team list share the same SQLite transaction queue", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-auth-and-lazy-queue", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-auth-and-lazy-queue", schema: {} });
    try {
      const signupGuest = await resolveAnonymousSession(database, null);
      const legacySession = await resolveAnonymousSession(database, null);
      const legacyAuth = {
        ...legacySession.auth, displayName: "Legacy Queue", email: "legacy-queue@example.com",
        isAuthenticated: true, isGuest: false, provider: "email",
      };
      await database.adapter.withTransaction((tx) => tx.linkAuthUser({
        id: legacyAuth.userId, displayName: legacyAuth.displayName, email: legacyAuth.email, picture: null,
        isAuthenticated: 1, isGuest: 0, provider: "email",
      }));

      const [signedUp, legacyTeams] = await Promise.all([
        signUpWithEmail(database, signupGuest, "email", {
          email: "queued-link@example.com", password: "password-123", name: "Queued Link",
        }),
        listCurrentUserTeams(database, legacyAuth),
      ]);
      assert.equal(signedUp.ok, true);
      assert.equal(teamCountForUser(database, signedUp.auth.userId), 1);
      assert.equal(legacyTeams.teams.length, 1);
      assert.equal(teamCountForUser(database, legacyAuth.userId), 1);
    } finally {
      await database.close();
    }
  });
});

test("email and every OAuth linking provider commit one initial Team while returning accounts remain unchanged", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-linking-seams",
      auth: { providers: { anonymous: true, email: true, google: true, microsoft: true, apple: true, facebook: true } },
    }, { name: "teams-linking-seams", schema: {} });
    try {
      const emailAnonymous = await resolveAnonymousSession(database, null);
      assert.equal(teamCount(database), 0, "ordinary anonymous browsing creates no Team rows");
      const emailLinked = await signUpWithEmail(database, emailAnonymous, "email", {
        email: "email@example.com", password: "password-123", name: "Email Owner",
      });
      assert.equal(emailLinked.ok, true);
      assert.equal(teamCountForUser(database, emailLinked.auth.userId), 1);
      const emailSignInAnonymous = await resolveAnonymousSession(database, null);
      const emailSignIn = await signInWithEmail(database, emailSignInAnonymous, {
        email: "email@example.com", password: "password-123", name: "Ignored",
      });
      assert.equal(emailSignIn.ok, true);
      assert.equal(teamCountForUser(database, emailLinked.auth.userId), 1, "email sign-in does not duplicate the initial Team");

      for (const provider of ["google", "microsoft", "apple", "facebook"]) {
        const firstAnonymous = await resolveAnonymousSession(database, null);
        const linked = await linkProviderIdentity(database, firstAnonymous, provider, {
          subject: `${provider}-new-user`, email: `${provider}@example.com`, displayName: `${provider} Owner`,
        });
        assert.equal(linked.ok, true, provider);
        assert.equal(teamCountForUser(database, linked.auth.userId), 1, `${provider} linking commits one Team`);
        assert.equal((await listCurrentUserTeams(database, linked.auth)).teams.length, 1, `${provider} caller immediately sees its Team`);

        const returningAnonymous = await resolveAnonymousSession(database, null);
        const returned = await linkProviderIdentity(database, returningAnonymous, provider, {
          subject: `${provider}-new-user`, email: `${provider}@example.com`, displayName: `${provider} Owner`,
        });
        assert.equal(returned.ok, true, `${provider} existing-account sign-in`);
        assert.equal(returned.auth.userId, linked.auth.userId, `${provider} returns the original account`);
        assert.equal(teamCountForUser(database, linked.auth.userId), 1, `${provider} sign-in does not duplicate the Team`);
      }
    } finally {
      await database.close();
    }
  });
});

test("a Team-bootstrap failure rolls back new email linking and retains the anonymous Session", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-linking-rollback", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-linking-rollback", schema: {} });
    const baseAdapter = database.adapter;
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      database.adapter = failTeamBootstrapMembershipInsert(baseAdapter, new Error("team membership exploded"));
      await assert.rejects(
        () => signUpWithEmail(database, anonymous, "email", {
          email: "rollback@example.com", password: "password-123", name: "Rollback",
        }),
        /team membership exploded/,
      );
      assert.equal(baseAdapter.emailCredentialExists("rollback@example.com"), false);
      assert.equal(teamCount(baseAdapter), 0);
      const preserved = baseAdapter.readAuthSessionWithUser(anonymous.token);
      assert.equal(preserved.userId, anonymous.auth.userId);
      assert.equal(preserved.provider, "anonymous");
      assert.equal(preserved.isGuest, 1);
    } finally {
      await database.close();
    }
  });
});

test("retried concurrent OAuth completions share one committed initial Team", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-linking-concurrency", auth: { providers: { anonymous: true, google: true } },
    }, { name: "teams-linking-concurrency", schema: {} });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      const profile = { subject: "concurrent-google-user", email: "concurrent@example.com", displayName: "Concurrent" };
      const results = await Promise.all([
        linkProviderIdentity(database, anonymous, "google", profile),
        linkProviderIdentity(database, anonymous, "google", profile),
      ]);
      assert.equal(results[0].ok, true);
      assert.equal(results[1].ok, true);
      assert.equal(results[0].auth.userId, results[1].auth.userId);
      assert.equal(teamCountForUser(database, results[0].auth.userId), 1);
      assert.equal((await listCurrentUserTeams(database, results[0].auth)).teams.length, 1);
    } finally {
      await database.close();
    }
  });
});

test("a linked user from before Team bootstrap still receives the initial Team lazily", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-legacy-lazy", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-legacy-lazy", schema: {} });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      const auth = { ...anonymous.auth, displayName: "Legacy", email: "legacy@example.com", isAuthenticated: true, isGuest: false, provider: "email" };
      await database.adapter.withTransaction((tx) => tx.linkAuthUser({
        id: auth.userId, displayName: auth.displayName, email: auth.email, picture: null,
        isAuthenticated: 1, isGuest: 0, provider: "email",
      }));
      assert.equal(teamCountForUser(database, auth.userId), 0);
      const teams = await listCurrentUserTeams(database, auth);
      assert.equal(teams.teams.length, 1);
      assert.equal(teamCountForUser(database, auth.userId), 1);
    } finally {
      await database.close();
    }
  });
});

test("a pre-Teams Google legacy account remains lazy when a guest restores it", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-legacy-google", auth: { providers: { anonymous: true, google: true } },
    }, { name: "teams-legacy-google", schema: {} });
    try {
      const legacySession = await resolveAnonymousSession(database, null);
      await database.adapter.withTransaction(async (tx) => {
        await tx.linkAuthUser({
          id: legacySession.auth.userId, displayName: "Legacy Google", email: "legacy-google@example.com", picture: null,
          isAuthenticated: 1, isGuest: 0, provider: "google",
        });
        await tx.insertAuthIdentity({
          id: "legacy-google-identity", userId: legacySession.auth.userId, provider: "google", subject: "legacy:google-email",
          email: "legacy-google@example.com", displayName: "Legacy Google", picture: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      });
      const guest = await resolveAnonymousSession(database, null);
      const restored = await linkProviderIdentity(database, guest, "google", {
        subject: "google-restored-subject", email: "legacy-google@example.com", emailVerified: true, displayName: "Legacy Google",
      });
      assert.equal(restored.ok, true);
      assert.equal(restored.auth.userId, legacySession.auth.userId);
      assert.equal(teamCountForUser(database, restored.auth.userId), 0, "legacy restoration must retain Ticket 01 lazy bootstrap");
      assert.equal((await listCurrentUserTeams(database, restored.auth)).teams.length, 1);
    } finally {
      await database.close();
    }
  });
});

test("new simulated identities bootstrap transactionally while existing simulated identities retain lazy Team history", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-simulated-linking", auth: { providers: { anonymous: true, email: true, google: true } },
    }, { name: "teams-simulated-linking", schema: {} });
    try {
      for (const provider of ["email", "google"]) {
        const simulated = await simulateLocalIdentitySession(database, {
          provider, email: `${provider}-simulated@example.com`, displayName: `${provider} Simulated`,
        });
        assert.equal(simulated.ok, true);
        assert.equal(teamCountForUser(database, simulated.data.auth.userId), 1, `${provider} simulated link commits its Team`);
        const repeated = await simulateLocalIdentitySession(database, {
          provider, email: `${provider}-simulated@example.com`, displayName: `${provider} Simulated`,
        });
        assert.equal(repeated.ok, true);
        assert.equal(repeated.data.auth.userId, simulated.data.auth.userId);
        assert.equal(teamCountForUser(database, simulated.data.auth.userId), 1, `${provider} simulated retry does not duplicate`);
      }

      const now = new Date().toISOString();
      await database.adapter.withTransaction(async (tx) => {
        await tx.insertAuthUser({
          id: "legacy-simulated-user", createdAt: now, displayName: "Legacy Simulated", email: "legacy-simulated@example.com",
          picture: null, isAuthenticated: 1, isGuest: 0, provider: "anonymous",
        });
        await tx.insertAuthIdentity({
          id: "legacy-simulated-identity", userId: "legacy-simulated-user", provider: "email", subject: "local:legacy-simulated@example.com",
          email: "legacy-simulated@example.com", displayName: "Legacy Simulated", picture: null, createdAt: now, updatedAt: now,
        });
      });
      const legacy = await simulateLocalIdentitySession(database, {
        provider: "email", email: "legacy-simulated@example.com", displayName: "Legacy Simulated",
      });
      assert.equal(legacy.ok, true);
      assert.equal(legacy.data.auth.userId, "legacy-simulated-user");
      assert.equal(teamCountForUser(database, legacy.data.auth.userId), 0);
      assert.equal((await listCurrentUserTeams(database, legacy.data.auth)).teams.length, 1);
    } finally {
      await database.close();
    }
  });
});

test("same-runtime concurrent simulated identity creation commits one Team", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-simulated-concurrency", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-simulated-concurrency", schema: {} });
    try {
      const options = { provider: "email", email: "concurrent-simulated@example.com", displayName: "Concurrent Simulated" };
      const [first, second] = await Promise.all([
        simulateLocalIdentitySession(database, options),
        simulateLocalIdentitySession(database, options),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.data.auth.userId, second.data.auth.userId);
      assert.equal(teamCountForUser(database, first.data.auth.userId), 1);
    } finally {
      await database.close();
    }
  });
});

test("separate SQLite runtimes retry concurrent simulated identity creation without duplicate Teams", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "teams-simulated-cross-runtime", auth: { providers: { anonymous: true, google: true } } };
    const capsule = { name: "teams-simulated-cross-runtime", schema: {} };
    const firstRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    const secondRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    try {
      const options = { provider: "google", email: "cross-runtime-simulated@example.com", displayName: "Cross Runtime Simulated" };
      const [first, second] = await Promise.all([
        simulateLocalIdentitySession(firstRuntime, options),
        simulateLocalIdentitySession(secondRuntime, options),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.data.auth.userId, second.data.auth.userId);
      assert.equal(teamCountForUser(firstRuntime, first.data.auth.userId), 1);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });
});

test("separate SQLite runtimes retry a concurrent OAuth account link without duplicate Teams", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "teams-linking-cross-runtime", auth: { providers: { anonymous: true, google: true } } };
    const capsule = { name: "teams-linking-cross-runtime", schema: {} };
    const firstRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    const secondRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    try {
      const firstGuest = await resolveAnonymousSession(firstRuntime, null);
      const secondGuest = await resolveAnonymousSession(secondRuntime, null);
      const profile = { subject: "cross-runtime-google", email: "cross-runtime@example.com", displayName: "Cross Runtime" };
      const [first, second] = await Promise.all([
        linkProviderIdentity(firstRuntime, firstGuest, "google", profile),
        linkProviderIdentity(secondRuntime, secondGuest, "google", profile),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.auth.userId, second.auth.userId);
      assert.equal(teamCountForUser(firstRuntime, first.auth.userId), 1);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });
});

test("OAuth linking retries a recognized Postgres provider-identity unique conflict", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-postgres-identity-conflict", auth: { providers: { anonymous: true, google: true } },
    }, { name: "teams-postgres-identity-conflict", schema: {} });
    const baseAdapter = database.adapter;
    try {
      const guest = await resolveAnonymousSession(database, null);
      database.adapter = failFirstAuthTransaction(baseAdapter, Object.assign(new Error("duplicate provider identity"), {
        code: "23505", constraint: "sporades_auth_identities_provider_subject_key",
      }));
      const linked = await linkProviderIdentity(database, guest, "google", {
        subject: "postgres-conflict-subject", email: "postgres-conflict@example.com", displayName: "Postgres Conflict",
      });
      assert.equal(linked.ok, true);
      assert.equal(teamCountForUser(database, linked.auth.userId), 1);
    } finally {
      database.adapter = baseAdapter;
      await database.close();
    }
  });
});

test("different linked users can bootstrap Teams concurrently on one SQLite runtime", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-concurrency-users",
      auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-concurrency-users", schema: {} });
    try {
      const firstAnonymous = await resolveAnonymousSession(database, null);
      const secondAnonymous = await resolveAnonymousSession(database, null);
      const first = await signUpWithEmail(database, firstAnonymous, "email", { email: "first@example.com", password: "password-123", name: "First" });
      const second = await signUpWithEmail(database, secondAnonymous, "email", { email: "second@example.com", password: "password-123", name: "Second" });
      const listed = await Promise.all([
        listCurrentUserTeams(database, first.auth),
        listCurrentUserTeams(database, second.auth),
      ]);
      assert.equal(listed[0].teams.length, 1);
      assert.equal(listed[1].teams.length, 1);
      assert.notEqual(listed[0].teams[0].id, listed[1].teams[0].id);
    } finally {
      await database.close();
    }
  });
});

test("different SQLite runtimes retry concurrent initial Team bootstraps", async () => {
  await withDatabase(async (databasePath) => {
    const config = {
      name: "teams-concurrency-runtimes",
      auth: { providers: { anonymous: true, email: true } },
    };
    const capsule = { name: "teams-concurrency-runtimes", schema: {} };
    const firstRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    const secondRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    try {
      const firstAnonymous = await resolveAnonymousSession(firstRuntime, null);
      const secondAnonymous = await resolveAnonymousSession(firstRuntime, null);
      const first = await signUpWithEmail(firstRuntime, firstAnonymous, "email", { email: "runtime-first@example.com", password: "password-123", name: "First" });
      const second = await signUpWithEmail(firstRuntime, secondAnonymous, "email", { email: "runtime-second@example.com", password: "password-123", name: "Second" });
      const listed = await Promise.all([
        listCurrentUserTeams(firstRuntime, first.auth),
        listCurrentUserTeams(secondRuntime, second.auth),
      ]);
      assert.equal(listed[0].teams.length, 1);
      assert.equal(listed[1].teams.length, 1);
      assert.notEqual(listed[0].teams[0].id, listed[1].teams[0].id);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });
});

test("Join redemption revalidates its capability and identity, commits one member, and safely retries", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-join-redemption", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-join-redemption", schema: {} });
    try {
      const ownerSession = await resolveAnonymousSession(database, null);
      const owner = await signUpWithEmail(database, ownerSession, "email", {
        email: "owner@example.com", password: "password-123", name: "Owner",
      });
      const recipientSession = await resolveAnonymousSession(database, null);
      const recipient = await signUpWithEmail(database, recipientSession, "email", {
        email: "recipient@example.com", password: "password-123", name: "Recipient",
      });
      const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
      const issued = await createTeamJoinLink(database, owner.auth, team.id, " Recipient@Example.com ", { ttlSeconds: 300 });
      const code = new URL(issued.link).searchParams.get("code");

      const joined = await joinCurrentUserTeam(database, recipient.auth, code);
      assert.deepEqual(joined, {
        team: { id: team.id, name: team.name, role: "member", applicationRoles: [], memberCount: 2 },
      });
      assert.deepEqual(await joinCurrentUserTeam(database, recipient.auth, code), joined, "the consuming user may retry without a duplicate membership or role grant");
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?").get(team.id, recipient.auth.userId).count, 1);
      assert.equal(database.adapter.prepare("SELECT [userId] FROM [sporades_team_join_link_redemptions] WHERE [joinLinkId] = ?").get(issued.id).userId, recipient.auth.userId);

      const sameEmailSession = await resolveAnonymousSession(database, null);
      const sameEmailUser = await signUpWithEmail(database, sameEmailSession, "email", {
        email: "other@example.com", password: "password-123", name: "Other",
      });
      const now = new Date().toISOString();
      await database.adapter.insertAuthIdentity({
        id: "same-email-oauth", userId: sameEmailUser.auth.userId, provider: "google", subject: "same-email-subject",
        email: "recipient@example.com", displayName: "Other", picture: null, createdAt: now, updatedAt: now,
      });
      await assert.rejects(() => joinCurrentUserTeam(database, sameEmailUser.auth, code), (error) => error?.code === "INVALID_JOIN_LINK");

      const race = await createTeamJoinLink(database, owner.auth, team.id, "recipient@example.com", { ttlSeconds: 300 });
      const raceCode = new URL(race.link).searchParams.get("code");
      const raceResults = await Promise.allSettled([
        joinCurrentUserTeam(database, recipient.auth, raceCode),
        joinCurrentUserTeam(database, sameEmailUser.auth, raceCode),
      ]);
      assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1, "same-email contenders consume at most one capability");
      assert.equal(raceResults.filter((result) => result.status === "rejected").length, 1);

      const oauthGuest = await resolveAnonymousSession(database, null);
      const oauth = await linkProviderIdentity(database, oauthGuest, "google", {
        subject: "join-oauth-subject", email: "oauth-recipient@example.com", displayName: "OAuth Recipient",
      });
      const oauthLink = await createTeamJoinLink(database, owner.auth, team.id, "oauth-recipient@example.com", { ttlSeconds: 300 });
      assert.equal((await joinCurrentUserTeam(database, oauth.auth, new URL(oauthLink.link).searchParams.get("code"))).team.role, "member", "an OAuth-attached email redeems normally");

      const anonymous = await resolveAnonymousSession(database, null);
      const unused = await createTeamJoinLink(database, owner.auth, team.id, "anonymous@example.com", { ttlSeconds: 300 });
      const unusedCode = new URL(unused.link).searchParams.get("code");
      await assert.rejects(() => joinCurrentUserTeam(database, anonymous.auth, unusedCode), (error) => error?.code === "UNAUTHENTICATED");
      assert.equal(database.adapter.prepare("SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [id] = ?").get(unused.id).consumedAt, null);
    } finally {
      await database.close();
    }
  });
});

test("Join redemption bootstraps legacy users only after validation and records redacted outcomes", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-legacy-join", auth: { providers: { anonymous: true, email: true, google: true } },
    }, { name: "teams-legacy-join", schema: {} });
    const baseAdapter = database.adapter;
    try {
      const ownerSession = await resolveAnonymousSession(database, null);
      const owner = await signUpWithEmail(database, ownerSession, "email", {
        email: "legacy-owner@example.com", password: "password-123", name: "Owner",
      });
      const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
      const now = new Date().toISOString();
      const legacy = { userId: "legacy-join-user", displayName: "Legacy", email: "legacy@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "google" };
      await database.adapter.withTransaction(async (tx) => {
        await tx.insertAuthUser({ id: legacy.userId, createdAt: now, displayName: legacy.displayName, email: legacy.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: legacy.provider });
        await tx.insertAuthIdentity({ id: "legacy-join-identity", userId: legacy.userId, provider: "google", subject: "legacy-join-subject", email: legacy.email, displayName: legacy.displayName, picture: null, createdAt: now, updatedAt: now });
      });
      assert.equal(teamCountForUser(database, legacy.userId), 0);
      await assert.rejects(() => joinCurrentUserTeam(database, legacy, "not-a-link"), (error) => error?.code === "INVALID_JOIN_LINK");
      assert.equal(teamCountForUser(database, legacy.userId), 0, "invalid redemption must not bootstrap a legacy account");

      const legacyDenied = { userId: "legacy-consumed-link-user", displayName: "Legacy denied", email: "legacy-consumed@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "google" };
      await database.adapter.withTransaction(async (tx) => {
        await tx.insertAuthUser({ id: legacyDenied.userId, createdAt: now, displayName: legacyDenied.displayName, email: legacyDenied.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: legacyDenied.provider });
        await tx.insertAuthIdentity({ id: "legacy-consumed-link-identity", userId: legacyDenied.userId, provider: "google", subject: "legacy-consumed-link-subject", email: legacyDenied.email, displayName: legacyDenied.displayName, picture: null, createdAt: now, updatedAt: now });
      });
      const consumer = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", {
        email: "legacy-consumer@example.com", password: "password-123", name: "Consumer",
      });
      await database.adapter.insertAuthIdentity({
        id: "legacy-consumer-identity", userId: consumer.auth.userId, provider: "google", subject: "legacy-consumer-subject",
        email: legacyDenied.email, displayName: "Consumer", picture: null, createdAt: now, updatedAt: now,
      });
      const consumedByOther = await createTeamJoinLink(database, owner.auth, team.id, legacyDenied.email, { ttlSeconds: 300 });
      const consumedByOtherCode = new URL(consumedByOther.link).searchParams.get("code");
      await joinCurrentUserTeam(database, consumer.auth, consumedByOtherCode);
      await assert.rejects(() => joinCurrentUserTeam(database, legacyDenied, consumedByOtherCode), (error) => error?.code === "INVALID_JOIN_LINK");
      assert.equal(teamCountForUser(database, legacyDenied.userId), 0, "a consumed Join link owned by another user must not bootstrap a legacy account");

      const issued = await createTeamJoinLink(database, owner.auth, team.id, legacy.email, { ttlSeconds: 300 });
      const code = new URL(issued.link).searchParams.get("code");
      const joined = await joinCurrentUserTeam(database, legacy, code);
      assert.equal(joined.team.role, "member");
      assert.equal(teamCountForUser(database, legacy.userId), 1, "valid redemption atomically creates the initial singleton Team");
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [userId] = ?").get(legacy.userId).count, 2);
      const audit = (await database.log.tail(20)).find((event) => event.event === "teams.joined" && event.data.actorUserId === legacy.userId);
      assert.deepEqual(audit.data, { operation: "teams.join", outcome: "succeeded", code: "TEAM_JOINED", actorUserId: legacy.userId, teamId: team.id });
      assert.doesNotMatch(JSON.stringify(audit), /legacy@example\.com|v1\./i);

      const rollback = await createTeamJoinLink(database, owner.auth, team.id, "rollback@example.com", { ttlSeconds: 300 });
      const rollbackCode = new URL(rollback.link).searchParams.get("code");
      const rollbackSession = await resolveAnonymousSession(database, null);
      const rollbackUser = await signUpWithEmail(database, rollbackSession, "email", { email: "rollback@example.com", password: "password-123", name: "Rollback" });
      database.adapter = failTeamBootstrapMembershipInsert(baseAdapter, new Error("join rollback"));
      await assert.rejects(() => joinCurrentUserTeam(database, rollbackUser.auth, rollbackCode), /join rollback/);
      database.adapter = baseAdapter;
      assert.equal(baseAdapter.prepare("SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [id] = ?").get(rollback.id).consumedAt, null, "failed membership insertion rolls back consumption");
    } finally {
      database.adapter = baseAdapter;
      await database.close();
    }
  });
});

test("a committed Join redemption retains its same-user retry outcome after runtime restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-join-restart-"));
  const databasePath = path.join(dir, "data.db");
  const config = { name: "teams-join-restart", auth: { providers: { anonymous: true, email: true } } };
  let database = await openDevDatabase(databasePath, "", {}, config, { name: "teams-join-restart", schema: {} });
  try {
    const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "restart-owner@example.com", password: "password-123", name: "Owner" });
    const recipient = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "restart-recipient@example.com", password: "password-123", name: "Recipient" });
    const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
    const issued = await createTeamJoinLink(database, owner.auth, team.id, "restart-recipient@example.com", { ttlSeconds: 300 });
    const code = new URL(issued.link).searchParams.get("code");
    const joined = await joinCurrentUserTeam(database, recipient.auth, code);
    await database.close();
    database = await openDevDatabase(databasePath, "", {}, config, { name: "teams-join-restart", schema: {} });
    assert.deepEqual(await joinCurrentUserTeam(database, recipient.auth, code), joined);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Privileged callbacks do not inherit current-user Teams", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, { name: "teams-privileged" }, {
      name: "teams-privileged",
      schema: {},
      mutations: {
        probe: mutation((ctx) => ctx.privileged.run(
          { operation: "teams.probe", targetResourceKind: "capsule-db" },
          (privileged) => Object.hasOwn(privileged, "teams"),
        )),
      },
    });
    try {
      const result = await runMutation(database, linkedAuth("user-one"), "probe", []);
      assert.deepEqual(result, { ok: true, data: false, error: null });
    } finally {
      await database.close();
    }
  });
});

test("a Capsule that never uses Teams retains auth, query, mutation, file, and ACL behavior", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-compatibility",
      auth: { providers: { anonymous: true, email: true } },
    }, {
      name: "teams-compatibility",
      schema: {
        notes: table({ ownerId: String(), body: String() }).acl({
          read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
          write: ({ next, ctx }) => next.ownerId === ctx.auth.userId,
        }),
      },
      queries: { mine: { kind: "query", handler: (ctx) => ctx.db.notes.all() } },
      mutations: { add: mutation((ctx, body) => ctx.db.notes.insert({ ownerId: ctx.auth.userId, body })) },
    });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      assert.deepEqual(Object.keys(anonymous.auth).sort(), ["displayName", "email", "isAuthenticated", "isGuest", "picture", "provider", "userId"]);
      const linked = await signUpWithEmail(database, anonymous, "email", {
        email: "compat@example.com", password: "password-123", name: "Compatible",
      });
      assert.equal((await runMutation(database, linked.auth, "add", ["unchanged"])).ok, true);
      assert.deepEqual((await runQuery(database, linked.auth, "mine")).data.map((row) => row.body), ["unchanged"]);
      assert.deepEqual((await runQuery(database, linkedAuth("other-user"), "mine")).data, []);
      const upload = await createPendingFileUpload(database, linked.auth, {
        file: { name: "note.txt", type: "text/plain", size: 4, path: "/notes/note.txt" },
      });
      assert.equal(upload.ok, true);
      assert.equal(upload.data.file.path, "/notes/note.txt");
    } finally {
      await database.close();
    }
  });
});

function linkedAuth(userId) {
  return { userId, displayName: "Owner", email: "owner@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
}

function teamCount(adapterOrDatabase) {
  const adapter = adapterOrDatabase.adapter ?? adapterOrDatabase;
  return Number(adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams]").get().count);
}

function teamCountForUser(database, userId) {
  return Number(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [createdByUserId] = ?").get(userId).count);
}

function failTeamApplicationRoleInsert(adapter, error) {
  const wrap = (target) => new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (property === "withTransaction") {
        return async (fn) => currentTarget.withTransaction(async (transactionAdapter) => fn(wrap(transactionAdapter)));
      }
      const value = Reflect.get(currentTarget, property, receiver);
      if (property !== "prepare" || typeof value !== "function") return value;
      return (statement) => {
        const prepared = value.call(currentTarget, statement);
        if (!`${statement}`.includes("INSERT INTO") || !`${statement}`.includes("sporades_team_membership_application_roles")) return prepared;
        return new Proxy(prepared, {
          get(preparedTarget, preparedProperty, preparedReceiver) {
            if (preparedProperty === "run") return () => { throw error; };
            return Reflect.get(preparedTarget, preparedProperty, preparedReceiver);
          },
        });
      };
    },
  });
  return wrap(adapter);
}

function failTeamBootstrapMembershipInsert(adapter, error) {
  const wrap = (target) => new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (property === "withTransaction") {
        return async (fn) => {
          const withTransaction = Reflect.get(currentTarget, property, receiver);
          return await withTransaction.call(currentTarget, async (transactionAdapter) => await fn(wrap(transactionAdapter)));
        };
      }
      const value = Reflect.get(currentTarget, property, receiver);
      if (property !== "prepare" || typeof value !== "function") return value;
      return (statement) => {
        const prepared = value.call(currentTarget, statement);
        if (!`${statement}`.includes("sporades_team_memberships")) return prepared;
        return { ...prepared, run() { throw error; } };
      };
    },
  });
  return wrap(adapter);
}

function failFirstAuthTransaction(adapter, error) {
  let first = true;
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property !== "withTransaction") return Reflect.get(target, property, receiver);
      return async (fn) => {
        if (first) {
          first = false;
          throw error;
        }
        return await target.withTransaction(fn);
      };
    },
  });
}

function recordTeamStatements(adapter, statements) {
  const wrap = (target) => new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (property === "withTransaction") {
        return async (fn) => currentTarget.withTransaction(async (transactionAdapter) => fn(wrap(transactionAdapter)));
      }
      const value = Reflect.get(currentTarget, property, receiver);
      if (property !== "prepare" || typeof value !== "function") return value;
      return (statement) => {
        statements.push(`${statement}`);
        return value.call(currentTarget, statement);
      };
    },
  });
  return wrap(adapter);
}

function assertLifecycleLockPrecedes(statements, mutableStatement, operation) {
  const lock = statements.findIndex((statement) => normalizedSql(statement).includes("UPDATE sporades_teams SET name = name WHERE id = ?"));
  const mutable = statements.findIndex((statement) => normalizedSql(statement).includes(mutableStatement));
  assert.ok(lock >= 0, `${operation} must acquire the Team lifecycle lock: ${statements.join(" | ")}`);
  assert.ok(mutable > lock, `${operation} must mutate Team-scoped state only after the Team lifecycle lock`);
}

function normalizedSql(statement) { return statement.replace(/["\[\]]/g, ""); }

function assertNoTeamAuditLeak(value, forbidden) {
  const serialized = JSON.stringify(value);
  for (const item of forbidden) assert.doesNotMatch(serialized, new RegExp(globalThis.String(item).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

async function withDatabase(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-runtime-"));
  try {
    return await fn(path.join(dir, "data.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

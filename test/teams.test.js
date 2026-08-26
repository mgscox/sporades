import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWebSocketHub, handleFileHttpRoute, openDevDatabase, recoverExpiredJobLeases, routeEndpoint, runAtomicStripeConsequence, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { Number as NumberField, String as StringField, endpoint, job, mutation, query, table } from "../dist/server.js";
import { createAdditionalTeam, joinCurrentUserTeam } from "../dist/teams-runtime.js";
import { applyVerifiedTeamBillingCheckoutObservation, expireTeamBillingCheckout, expireTeamBillingPortal, readCurrentUserTeamBilling } from "../dist/team-billing-runtime.js";
import { applyVerifiedTeamBillingObservation } from "../dist/team-billing-convergence.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

let trustedValidationCode = null;
let trustedJoinCode = null;
let observedFileAclTeams = null;

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
    ownTeamMemberCount: {
      kind: "query",
      handler: async (ctx) => {
        const { teams } = await ctx.teams.list();
        return ctx.teams.countMembers(teams[0].id);
      },
    },
    validateOwnJoinLink: {
      kind: "query",
      handler: (ctx) => ctx.teams.validateJoinLink(trustedValidationCode),
    },
  },
  mutations: {
    createAdditionalTeam: mutation((ctx, name) => ctx.teams.create(name)),
    renameAdditionalTeam: mutation((ctx, teamId, name) => ctx.teams.rename(teamId, name)),
    promoteTeamMember: mutation((ctx, teamId, userId) => ctx.teams.promote(teamId, userId)),
    demoteTeamMember: mutation((ctx, teamId, userId) => ctx.teams.demote(teamId, userId)),
    deleteOwnedTeam: mutation((ctx, teamId) => ctx.teams.delete(teamId)),
    joinOwnTeam: mutation((ctx) => ctx.teams.join(trustedJoinCode)),
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

const rolesCapsule = {
  ...capsule,
  name: "teams-roles-test",
  teams: { appRoles: ["author", "reviewer"] },
  queries: {
    ...capsule.queries,
    roleMembers: query(async (ctx) => {
      const { teams } = await ctx.teams.list();
      return ctx.teams.listMembers(teams[0].id);
    }),
  },
  mutations: {
    ...capsule.mutations,
    updateMemberRoles: mutation((ctx, teamId, userId, changes) => ctx.teams.updateApplicationRoles(teamId, userId, changes)),
  },
};

const observedJoinAdmissions = [];
let admissionFailureMessage = null;
let leakedAdmissionTable = null;
let admissionAuthMutationTarget = null;
let admissionAuthMutationRejected = false;
let leakedAdmissionTeamBilling = null;
const admissionCapsule = {
  ...capsule,
  name: "teams-admission-test",
  schema: {
    seatPolicies: table({ teamId: StringField(), maximumMembers: NumberField() }).acl({
      read: ({ row, ctx }) => ctx.acl.teams.isMember(row.teamId),
    }),
  },
  queries: {
    ...capsule.queries,
    seatPolicies: query((ctx, teamId) => ctx.db.seatPolicies.where("teamId", teamId).all()),
  },
  teams: {
    async admitJoin(ctx, input) {
      const policies = await ctx.db.seatPolicies.where("teamId", input.teamId).all();
      const billing = await ctx.teamBilling.get(input.teamId);
      ctx.log.info("Team join admission checked", {
        teamId: input.teamId,
        userId: input.userId,
        currentMemberCount: input.currentMemberCount,
      });
      leakedAdmissionTable = ctx.db.seatPolicies;
      leakedAdmissionTeamBilling = ctx.teamBilling;
      observedJoinAdmissions.push({
        ...input,
        actorUserId: ctx.auth.userId,
        contextKeys: Object.keys(ctx).sort(),
        tableKeys: Object.keys(ctx.db.seatPolicies).sort(),
        billingState: billing.state,
      });
      if (admissionAuthMutationTarget) {
        try {
          ctx.auth.userId = admissionAuthMutationTarget;
        } catch {
          admissionAuthMutationRejected = true;
        }
      }
      if (admissionFailureMessage) throw new Error(admissionFailureMessage);
      return { allow: Boolean(policies[0] && input.currentMemberCount < policies[0].maximumMembers) };
    },
  },
  mutations: {
    ...capsule.mutations,
    updateSeatPolicyAndJoin: mutation(async (ctx, policyId, maximumMembers, code) => {
      await ctx.db.seatPolicies.update(policyId, { maximumMembers });
      return ctx.teams.join(code);
    }),
  },
};

let capturedBillingPolicyTable = null;
let capturedBillingPolicyCountMembers = null;
const billingPolicyChecks = [];
const billingCapsule = {
  ...capsule,
  name: "team-billing-test",
  schema: {
    billingHolders: table({ teamId: StringField(), userId: StringField() }).unique("teamId"),
  },
  mutations: {
    ...capsule.mutations,
    setBillingHolder: mutation(async (ctx, teamId, userId) => {
      const existing = await ctx.db.billingHolders.where("teamId", teamId).get();
      return existing
        ? ctx.db.billingHolders.update(existing.id, { userId })
        : ctx.db.billingHolders.insert({ teamId, userId });
    }),
    removeBillingTeamMember: mutation((ctx, teamId, userId) => ctx.teams.removeMember(teamId, userId)),
  },
  teamBilling: {
    checkout: { successPath: "/settings/billing/success", cancelPath: "/settings/billing/cancelled", continuationTtlSeconds: 600 },
    portal: { returnPath: "/settings/billing", continuationTtlSeconds: 600 },
    catalogue: {
      studio: {
        quantity: { kind: "fixed", value: 1 },
        stripe: { sandbox: { productId: "prod_test_studio", priceId: "price_test_studio", portalConfigurationId: "bpc_test_studio" }, live: { productId: "prod_live_studio", priceId: "price_live_studio", portalConfigurationId: "bpc_live_studio" } },
      },
      agency: {
        quantity: { kind: "team-members" },
        stripe: { sandbox: { productId: "prod_test_agency", priceId: "price_test_agency", portalConfigurationId: "bpc_test_agency" }, live: { productId: "prod_live_agency", priceId: "price_live_agency", portalConfigurationId: "bpc_live_agency" } },
      },
      "agency-pro": {
        quantity: { kind: "team-members" },
        stripe: { sandbox: { productId: "prod_test_agency", priceId: "price_test_agency_pro", portalConfigurationId: "bpc_test_agency" }, live: { productId: "prod_live_agency", priceId: "price_live_agency_pro", portalConfigurationId: "bpc_live_agency" } },
      },
    },
    async authorize(ctx, input) {
      const holder = await ctx.db.billingHolders.where("teamId", input.teamId).get();
      const memberCount = input.operation === "plan-transition"
        ? await ctx.teams.countMembers(input.teamId) : null;
      capturedBillingPolicyTable = ctx.db.billingHolders;
      capturedBillingPolicyCountMembers = ctx.teams.countMembers;
      billingPolicyChecks.push({
        input,
        actorUserId: ctx.auth.userId,
        memberCount,
        contextKeys: Object.keys(ctx).sort(),
        tableKeys: Object.keys(ctx.db.billingHolders).sort(),
      });
      return { allow: holder?.userId === ctx.auth.userId };
    },
  },
};

test("a Team member removal stages Agency seat convergence through the owning app mutation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-member-removal-"));
  const providerCalls = [];
  const serverEnv = {
    STRIPE_SECRET_KEY: "sk_test_team_member_removal",
    STRIPE_WEBHOOK_SECRET: "whsec_team_member_removal",
  };
  const runtime = await startRuntime(path.join(dir, "data.db"), billingCapsule, {
    serverEnv,
    config: {
      payments: { stripe: {
        enabled: true,
        secretKeyEnv: "STRIPE_SECRET_KEY",
        webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
        publicOrigin: "https://member-removal.example.test",
        callbackPath: "/stripe/webhook",
        apiVersion: "2026-07-29.dahlia",
        livemode: false,
        requestTimeoutMs: 10_000,
      } },
    },
    runtimeOptions: {
      createStripeCallbackEndpoint,
      createStripeTeamBillingProvider: () => ({
        async updateManagedSubscription(input) {
          providerCalls.push(input);
          return { ok: true, outcome: "acknowledged" };
        },
      }),
    },
  });
  let owner;
  let member;
  try {
    owner = await runtime.open();
    member = await runtime.open();
    const ownerSignUp = await signUp(owner, "billing-removal-owner", "billing-removal-owner@example.com", "Billing owner");
    const memberSignUp = await signUp(member, "billing-removal-member", "billing-removal-member@example.com", "Billing member");
    const team = (await send(owner, {
      id: "billing-removal-team",
      type: "teams.list",
      sessionToken: ownerSignUp.data.sessionToken,
    })).data.teams[0];
    const now = new Date().toISOString();
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)",
    ).run(team.id, memberSignUp.data.auth.userId, now);
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', ?, ?, ?)",
    ).run(team.id, "cus_removal", now, now);
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES (?, ?, 'sandbox', ?, ?, ?, 'agency', 2, 'active', 0, ?, ?, 0)",
    ).run("billing-removal-subscription", team.id, "sub_removal", "price_test_agency", "si_removal", now, now);
    const holder = await send(owner, {
      id: "billing-removal-holder",
      type: "mutation.run",
      mutation: "setBillingHolder",
      args: [team.id, ownerSignUp.data.auth.userId],
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(holder.error, null, JSON.stringify(holder.error));
    await runtime.database.init();

    const removed = await send(owner, {
      id: "billing-removal-mutation",
      type: "mutation.run",
      mutation: "removeBillingTeamMember",
      args: [team.id, memberSignUp.data.auth.userId],
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.deepEqual(removed.data, { removed: true });

    const teams = await send(owner, {
      id: "billing-removal-teams-after",
      type: "teams.list",
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(teams.data.teams.find((candidate) => candidate.id === team.id).memberCount, 1);
    const billing = await send(owner, {
      id: "billing-removal-pending",
      type: "teamBilling.get",
      teamId: team.id,
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(billing.data.state, "pending");
    assert.equal(billing.data.operation, "reconciliation");
    assert.equal(billing.data.teamId, team.id);
    const providerDeadline = Date.now() + 10_000;
    while (providerCalls.length === 0 && Date.now() < providerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(providerCalls.length, 1, "the committed membership mutation dispatches its durable convergence Job");
    assert.equal(providerCalls[0].targetQuantity, 1);
  } finally {
    owner?.close();
    member?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const fileAclCapsule = {
  ...rolesCapsule,
  name: "teams-file-acl-test",
  files: {
    acl: {
      read: ({ file, ctx }) => {
        observedFileAclTeams = ctx.teams;
        const teamId = file.path.split("/")[2];
        if (file.name === "any-role.txt") return ctx.acl.teams.hasAnyRole(teamId, ["author", "reviewer"]);
        if (file.name === "inactive-role.txt") return ctx.acl.teams.hasRole(teamId, "retired");
        return ctx.acl.teams.isMember(teamId);
      },
      publicUrl: ({ file, ctx }) => ctx.acl.teams.isAdmin(file.path.split("/")[2]),
      delete: ({ file, ctx }) => ctx.acl.teams.hasRole(file.path.split("/")[2], "author"),
    },
  },
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
    const pendingJoinLink = await send(owner, {
      id: "members-pending-join-link",
      type: "teams.createJoinLink",
      teamId: teamA,
      email: "pending-member@example.com",
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(pendingJoinLink.error, null, JSON.stringify(pendingJoinLink.error));

    const browser = await send(owner, { id: "members-owner-list", type: "teams.listMembers", teamId: teamA, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(browser.error, null, JSON.stringify(browser.error));
    assert.equal(browser.type, "teams.listMembers.result");
    assert.equal(browser.data.members.length, 100, "omitting options preserves the previous page-size bound");
    assert.equal(browser.data.totalCount, 112, "the exact total is not capped with the display page");
    assert.equal(typeof browser.data.nextCursor, "string");
    assert.deepEqual(Object.keys(browser.data.members[0]).sort(), ["applicationRoles", "displayName", "picture", "role", "userId"]);
    assert.deepEqual(browser.data.members.find((entry) => entry.userId === ownerSignUp.data.auth.userId), {
      userId: ownerSignUp.data.auth.userId, displayName: "Owner", picture: "https://example.com/owner.png", role: "admin", applicationRoles: [],
    });
    assert.deepEqual(browser.data.members.find((entry) => entry.userId === memberSignUp.data.auth.userId), {
      userId: memberSignUp.data.auth.userId, displayName: "Member", picture: "https://example.com/member.png", role: "member", applicationRoles: [],
    });
    assertNoTeamLeak(browser.data, ["members-owner@example.com", "members-member@example.com", "bounded-0@example.com", "password", "sessionToken", "provider"]);

    const seen = [];
    let cursor;
    do {
      const page = await send(owner, {
        id: `members-page-${seen.length}`, type: "teams.listMembers", teamId: teamA,
        cursor, limit: 17, sessionToken: ownerSignUp.data.sessionToken,
      });
      assert.equal(page.error, null, JSON.stringify(page.error));
      assert.equal(page.data.totalCount, 112);
      assert.ok(page.data.members.length <= 17);
      seen.push(...page.data.members.map((entry) => entry.userId));
      cursor = page.data.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 112);
    assert.equal(new Set(seen).size, 112, "every member is returned exactly once");

    for (const [id, options] of [
      ["members-bad-cursor", { cursor: "not-an-opaque-cursor", limit: 10 }],
      ["members-corrupt-cursor", { cursor: `${browser.data.nextCursor}!`, limit: 10 }],
      ["members-bad-limit", { limit: 0 }],
    ]) {
      const invalidPage = await send(owner, { id, type: "teams.listMembers", teamId: teamA, ...options, sessionToken: ownerSignUp.data.sessionToken });
      assert.equal(invalidPage.error.code, "INVALID_TEAM_MEMBER_PAGE");
      assertNoTeamLeak(invalidPage, [teamA, "members-owner@example.com", "Bounded 0"]);
    }

    const trusted = await runQuery(runtime.database, ownerSignUp.data.auth, "ownTeamMembers");
    assert.deepEqual(trusted, { data: browser.data, error: null }, "trusted handler calls share the browser result and authorization contract");

    const browserCount = await send(member, { id: "members-ordinary-count", type: "teams.countMembers", teamId: teamA, sessionToken: memberSignUp.data.sessionToken });
    const adminCount = await send(owner, { id: "members-admin-count", type: "teams.countMembers", teamId: teamA, sessionToken: ownerSignUp.data.sessionToken });
    for (const count of [browserCount, adminCount]) {
      assert.deepEqual(count, { id: count.id, type: "teams.countMembers.result", data: { totalCount: 112 }, error: null });
    }

    const trustedCount = await runQuery(runtime.database, memberSignUp.data.auth, "ownTeamMemberCount");
    assert.deepEqual(trustedCount, { data: { totalCount: 112 }, error: null }, "an ordinary current member can read the exact accepted count without receiving a directory");

    const ordinaryMember = await send(member, { id: "members-ordinary-denied", type: "teams.listMembers", teamId: teamA, sessionToken: memberSignUp.data.sessionToken });
    const otherTeamAdmin = await send(otherAdmin, { id: "members-cross-team-denied", type: "teams.listMembers", teamId: teamA, sessionToken: otherAdminSignUp.data.sessionToken });
    const nonMember = await send(stranger, { id: "members-nonmember-denied", type: "teams.listMembers", teamId: teamA, sessionToken: strangerSignUp.data.sessionToken });
    const malformed = await send(stranger, { id: "members-malformed-denied", type: "teams.listMembers", teamId: "not-a-team-id", sessionToken: strangerSignUp.data.sessionToken });
    for (const denied of [ordinaryMember, otherTeamAdmin, nonMember, malformed]) {
      assert.equal(denied.type, "error");
      assert.equal(denied.error.code, "DENIED");
      assertNoTeamLeak(denied, [teamA, "members-owner@example.com", "Owner"]);
    }

    const countNonMember = await send(stranger, { id: "members-count-nonmember-denied", type: "teams.countMembers", teamId: teamA, sessionToken: strangerSignUp.data.sessionToken });
    const countUnknown = await send(stranger, { id: "members-count-unknown-denied", type: "teams.countMembers", teamId: "00000000-0000-4000-8000-000000000000", sessionToken: strangerSignUp.data.sessionToken });
    for (const denied of [countNonMember, countUnknown]) {
      assert.deepEqual(denied, {
        id: denied.id,
        type: "error",
        data: null,
        error: {
          code: "DENIED",
          message: "Could not read this Team's member count.",
          hint: "Sign in as a current Team member and retry.",
        },
      });
      assertNoTeamLeak(denied, [teamA, "members-owner@example.com", "Owner"]);
    }

    await runtime.database.adapter.withTransaction(async (tx) => {
      for (const userId of seen.slice(100)) {
        await tx.prepare("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?").run(teamA, userId);
      }
    });
    const committedCount = await send(member, { id: "members-count-after-committed-removal", type: "teams.countMembers", teamId: teamA, sessionToken: memberSignUp.data.sessionToken });
    assert.deepEqual(committedCount, { id: "members-count-after-committed-removal", type: "teams.countMembers.result", data: { totalCount: 100 }, error: null });
    const emptyFinal = await send(owner, { id: "members-empty-final", type: "teams.listMembers", teamId: teamA, cursor: browser.data.nextCursor, limit: 1, sessionToken: ownerSignUp.data.sessionToken });
    assert.deepEqual(emptyFinal.data, { members: [], totalCount: 100 }, "a page emptied by committed removal terminates without another cursor");
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

    const invalidEmail = await send(owner, { id: "join-invalid-email", type: "teams.createJoinLink", teamId, email: "not an email" });
    assert.equal(invalidEmail.error.code, "INVALID_EMAIL");
    const invalidAudit = (await runtime.database.log.tail(20)).find((event) => event.event === "teams.joinLink.create" && event.data.code === "INVALID_EMAIL" && event.data.actorUserId === ownerSignUp.data.auth.userId && event.data.teamId === teamId);
    assert.deepEqual(invalidAudit.data, {
      operation: "teams.createJoinLink", outcome: "denied", code: "INVALID_EMAIL", actorUserId: ownerSignUp.data.auth.userId, teamId,
    });
    assertNoTeamLeak(invalidAudit, ["not an email", "Recipient@Example.com", code, created.data.link, ownerSignUp.data.sessionToken]);

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

test("linked users validate their email-bound Join links without consuming them through browser and trusted seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-join-validation-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let recipient;
  let anonymous;
  try {
    owner = await runtime.open();
    recipient = await runtime.open();
    anonymous = await runtime.open();
    const ownerSignUp = await signUp(owner, "validate-owner", "validate-owner@example.com", "Validate Owner");
    const recipientSignUp = await signUp(recipient, "validate-recipient", "  Recipient@Example.com  ", "Validate Recipient");
    const teamId = (await send(owner, { id: "validate-owner-teams", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0].id;
    const create = async (id, email, ttlSeconds = 3600) => {
      const created = await send(owner, { id, type: "teams.createJoinLink", teamId, email, ttlSeconds, sessionToken: ownerSignUp.data.sessionToken });
      assert.equal(created.error, null, JSON.stringify(created.error));
      return { id: created.data.id, code: new URL(created.data.link).searchParams.get("code") };
    };
    const matching = await create("validate-matching-create", "recipient@example.com");

    const before = runtime.database.adapter.prepare("SELECT [consumedAt], [revokedAt], [expiresAt] FROM [sporades_team_join_links] WHERE [id] = ?").get(matching.id);
    const browser = await send(recipient, { id: "validate-matching-browser", type: "teams.validateJoinLink", code: matching.code, sessionToken: recipientSignUp.data.sessionToken });
    assert.equal(browser.error, null, JSON.stringify(browser.error));
    assert.deepEqual(browser.data, { valid: true });
    trustedValidationCode = matching.code;
    const trusted = await runQuery(runtime.database, recipientSignUp.data.auth, "validateOwnJoinLink");
    assert.deepEqual(trusted, { data: { valid: true }, error: null });
    assert.deepEqual(runtime.database.adapter.prepare("SELECT [consumedAt], [revokedAt], [expiresAt] FROM [sporades_team_join_links] WHERE [id] = ?").get(matching.id), before, "validation neither reserves nor consumes a valid link");
    assert.deepEqual(await send(recipient, { id: "validate-matching-repeat", type: "teams.validateJoinLink", code: matching.code, sessionToken: recipientSignUp.data.sessionToken }).then((result) => result.data), { valid: true }, "a valid link remains repeatably checkable");

    const anonymousResult = await send(anonymous, { id: "validate-anonymous", type: "teams.validateJoinLink", code: matching.code });
    assert.equal(anonymousResult.error, null, JSON.stringify(anonymousResult.error));
    assert.deepEqual(anonymousResult.data, { valid: false });
    const mismatch = await create("validate-mismatch-create", "other@example.com");
    const malformed = "not-a-join-link";
    for (const [id, code] of [["validate-mismatch", mismatch.code], ["validate-malformed", malformed], ["validate-unknown", matching.code.replace(/^v1\.[^.]+/, "v1.aaaaaaaaaaaaaaaa")]]) {
      const result = await send(recipient, { id, type: "teams.validateJoinLink", code, sessionToken: recipientSignUp.data.sessionToken });
      assert.equal(result.error, null, JSON.stringify(result.error));
      assert.deepEqual(result.data, { valid: false });
    }

    const revoked = await create("validate-revoked-create", "recipient@example.com");
    await runtime.database.adapter.prepare("UPDATE [sporades_team_join_links] SET [revokedAt] = ? WHERE [id] = ?").run(new Date().toISOString(), revoked.id);
    const consumed = await create("validate-consumed-create", "recipient@example.com");
    await runtime.database.adapter.prepare("UPDATE [sporades_team_join_links] SET [consumedAt] = ? WHERE [id] = ?").run(new Date().toISOString(), consumed.id);
    const expired = await create("validate-expired-create", "recipient@example.com", 300);
    await runtime.database.adapter.prepare("UPDATE [sporades_team_join_links] SET [expiresAt] = ? WHERE [id] = ?").run(new Date(Date.now() - 1_000).toISOString(), expired.id);
    for (const [id, code] of [["validate-revoked", revoked.code], ["validate-consumed", consumed.code], ["validate-expired", expired.code]]) {
      const result = await send(recipient, { id, type: "teams.validateJoinLink", code, sessionToken: recipientSignUp.data.sessionToken });
      assert.equal(result.error, null, JSON.stringify(result.error));
      assert.deepEqual(result.data, { valid: false });
    }

    const identityTarget = await create("validate-identity-create", " identity@example.com ");
    const now = new Date().toISOString();
    await runtime.database.adapter.insertAuthIdentity({ id: "validate-identity", userId: recipientSignUp.data.auth.userId, provider: "google", subject: "identity-subject", email: " Identity@Example.com ", displayName: null, picture: null, createdAt: now, updatedAt: now });
    await runtime.database.adapter.insertAuthIdentity({ id: "validate-email-less-identity", userId: recipientSignUp.data.auth.userId, provider: "microsoft", subject: "email-less-subject", email: null, displayName: null, picture: null, createdAt: now, updatedAt: now });
    const identityBrowser = await send(recipient, { id: "validate-identity-browser", type: "teams.validateJoinLink", code: identityTarget.code, sessionToken: recipientSignUp.data.sessionToken });
    assert.deepEqual(identityBrowser.data, { valid: true }, "any attached provider email can match without a provider-specific call or verified-email policy");
    trustedValidationCode = identityTarget.code;
    assert.deepEqual(await runQuery(runtime.database, recipientSignUp.data.auth, "validateOwnJoinLink"), { data: { valid: true }, error: null });
    assertNoTeamLeak(identityBrowser.data, ["recipient@example.com", "identity@example.com", "identity-subject", identityTarget.code]);
    assert.equal((await runtime.database.log.tail(100)).filter((event) => event.event.includes("joinLink") && event.event.includes("validate")).length, 0, "validation logs no capability or identity details");
  } finally {
    trustedValidationCode = null;
    owner?.close(); recipient?.close(); anonymous?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a linked recipient redeems a Join link through browser and trusted Team seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-join-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let recipient;
  try {
    owner = await runtime.open();
    const ownerSignUp = await signUp(owner, "join-owner", "join-owner@example.com", "Join Owner");
    const team = (await send(owner, { id: "join-owner-teams", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const issued = await send(owner, {
      id: "join-issue", type: "teams.createJoinLink", teamId: team.id,
      email: "recipient@example.com", ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    const code = new URL(issued.data.link).searchParams.get("code");

    recipient = await runtime.open();
    const recipientSignUp = await signUp(recipient, "join-recipient", "recipient@example.com", "Recipient");
    const browser = await send(recipient, {
      id: "join-browser", type: "teams.join", code, sessionToken: recipientSignUp.data.sessionToken,
    });
    assert.equal(browser.error, null, JSON.stringify(browser.error));
    assert.deepEqual(browser.data, {
      team: { id: team.id, name: team.name, role: "member", applicationRoles: [], memberCount: 2 },
    });

    trustedJoinCode = code;
    assert.deepEqual(
      await runMutation(runtime.database, recipientSignUp.data.auth, "joinOwnTeam", []),
      { ok: true, data: browser.data, error: null },
      "a same-user retry is idempotent through the trusted current-user API",
    );
    assert.equal(runtime.database.adapter.prepare(
      "SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
    ).get(team.id, recipientSignUp.data.auth.userId).role, "member");
  } finally {
    trustedJoinCode = null;
    owner?.close(); recipient?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Capsule Team admission is transaction-bound and serializes concurrent joins for the final seat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-admission-"));
  const databasePath = path.join(dir, "data.db");
  const first = await startRuntime(databasePath, admissionCapsule);
  let second;
  let owner;
  let firstRecipient;
  let secondRecipient;
  let thirdRecipient;
  let fifthRecipient;
  let sixthRecipient;
  try {
    owner = await first.open();
    firstRecipient = await first.open();
    secondRecipient = await first.open();
    const ownerSignUp = await signUp(owner, "admission-owner", "admission-owner@example.com", "Admission Owner");
    const firstSignUp = await signUp(firstRecipient, "admission-first", "admission-first@example.com", "First Recipient");
    const secondSignUp = await signUp(secondRecipient, "admission-second", "admission-second@example.com", "Second Recipient");
    const team = (await send(owner, { id: "admission-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const now = new Date().toISOString();
    await first.database.adapter.prepare(
      "INSERT INTO [seatPolicies] ([id], [createdAt], [updatedAt], [teamId], [maximumMembers]) VALUES (?, ?, ?, ?, ?)",
    ).run("seat-policy", now, now, team.id, 2);

    const issue = async (id, email) => {
      const result = await send(owner, { id, type: "teams.createJoinLink", teamId: team.id, email, ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken });
      assert.equal(result.error, null, JSON.stringify(result.error));
      return new URL(result.data.link).searchParams.get("code");
    };
    const [firstCode, secondCode] = await Promise.all([
      issue("admission-first-link", "admission-first@example.com"),
      issue("admission-second-link", "admission-second@example.com"),
    ]);

    second = await openDevDatabase(databasePath, "", {}, {
      name: "teams-admission-test", auth: { providers: { anonymous: true, email: true } },
    }, admissionCapsule);
    observedJoinAdmissions.length = 0;
    assert.deepEqual(
      await runQuery(first.database, firstSignUp.data.auth, "seatPolicies", [team.id]),
      { data: [], error: null },
      "ordinary invitee reads remain filtered by the member-only row ACL",
    );
    const attempts = await Promise.allSettled([
      joinCurrentUserTeam(first.database, firstSignUp.data.auth, firstCode),
      joinCurrentUserTeam(second, secondSignUp.data.auth, secondCode),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const denied = attempts.find((attempt) => attempt.status === "rejected");
    assert.equal(denied.reason.code, "TEAM_JOIN_DENIED");
    assert.deepEqual({ message: denied.reason.message, hint: denied.reason.hint }, {
      message: "Could not join this Team.",
      hint: "Ask a Team administrator for access.",
    });
    assert.equal(observedJoinAdmissions.length, 2, "every new-membership join invokes trusted policy");
    assert.deepEqual(observedJoinAdmissions.map((entry) => entry.currentMemberCount).sort(), [1, 2]);
    assert.equal(
      (await first.database.adapter.readRecentLogEvents(50)).filter(
        (entry) => entry.message === "Team join admission checked" && entry.data?.teamId === team.id,
      ).length,
      1,
      "only the admitted Join commits its transaction-scoped application log",
    );
    assert.ok(observedJoinAdmissions.every((entry) => entry.teamId === team.id && entry.userId === entry.actorUserId));
    assert.ok(observedJoinAdmissions.every((entry) => JSON.stringify(entry.contextKeys) === JSON.stringify(["auth", "db", "env", "log", "teamBilling"])));
    assert.ok(observedJoinAdmissions.every((entry) => entry.billingState === "inactive"));
    assert.ok(observedJoinAdmissions.every((entry) => JSON.stringify(entry.tableKeys) === JSON.stringify(["all", "get", "limit", "orderBy", "where"])));
    assert.throws(() => leakedAdmissionTable.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    await assert.rejects(() => leakedAdmissionTeamBilling.get(observedJoinAdmissions.at(-1).teamId), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");

    const admittedIndex = attempts.findIndex((attempt) => attempt.status === "fulfilled");
    const admissionsBeforeRetry = observedJoinAdmissions.length;
    await joinCurrentUserTeam(
      first.database,
      admittedIndex === 0 ? firstSignUp.data.auth : secondSignUp.data.auth,
      admittedIndex === 0 ? firstCode : secondCode,
    );
    assert.equal(observedJoinAdmissions.length, admissionsBeforeRetry, "same-user retries do not re-run admission");

    const members = await send(owner, { id: "admission-members", type: "teams.listMembers", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(members.data.totalCount, 2);
    const deniedCode = attempts[0].status === "rejected" ? firstCode : secondCode;
    const deniedLink = first.database.adapter.prepare(
      "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
    ).get(deniedCode.split(".")[1]);
    assert.equal(deniedLink.consumedAt, null, "policy denial rolls capability and membership writes back together");

    thirdRecipient = await first.open();
    const thirdSignUp = await signUp(thirdRecipient, "admission-third", "admission-third@example.com", "Third Recipient");
    const thirdCode = await issue("admission-third-link", "admission-third@example.com");
    const trustedJoined = await runMutation(first.database, thirdSignUp.data.auth, "updateSeatPolicyAndJoin", ["seat-policy", 3, thirdCode]);
    assert.equal(trustedJoined.ok, true, JSON.stringify(trustedJoined));
    assert.equal(trustedJoined.data.team.memberCount, 3, "admission sees app state updated earlier in the same mutation transaction");

    const fourthRecipient = await first.open();
    const fourthSignUp = await signUp(fourthRecipient, "admission-fourth", "admission-fourth@example.com", "Fourth Recipient");
    const fourthCode = await issue("admission-fourth-link", "admission-fourth@example.com");
    const publicDenied = await send(fourthRecipient, {
      id: "admission-public-denied", type: "teams.join", code: fourthCode, sessionToken: fourthSignUp.data.sessionToken,
    });
    assert.deepEqual(publicDenied.error, {
      code: "TEAM_JOIN_DENIED", message: "Could not join this Team.", hint: "Ask a Team administrator for access.",
    });
    assertNoTeamLeak(publicDenied, [team.id, "admission-fourth@example.com", fourthCode, "maximumMembers"]);
    assert.equal(observedJoinAdmissions.length, 4, "trusted and public join transports cannot omit or bypass admission");
    fourthRecipient.close();

    await first.database.adapter.prepare("DELETE FROM [seatPolicies] WHERE [id] = ?").run("seat-policy");
    fifthRecipient = await first.open();
    const fifthSignUp = await signUp(fifthRecipient, "admission-fifth", "admission-fifth@example.com", "Fifth Recipient");
    const fifthCode = await issue("admission-fifth-link", "admission-fifth@example.com");
    const missingPolicy = await send(fifthRecipient, {
      id: "admission-missing-policy", type: "teams.join", code: fifthCode, sessionToken: fifthSignUp.data.sessionToken,
    });
    assert.equal(missingPolicy.error.code, "TEAM_JOIN_DENIED");
    assert.equal(first.database.adapter.prepare(
      "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
    ).get(fifthCode.split(".")[1]).consumedAt, null, "missing protected policy data leaves the Join link usable");

    await first.database.adapter.prepare(
      "INSERT INTO [seatPolicies] ([id], [createdAt], [updatedAt], [teamId], [maximumMembers]) VALUES (?, ?, ?, ?, ?)",
    ).run("seat-policy", now, now, team.id, 4);
    const cancelled = new AbortController();
    cancelled.abort();
    const admissionsBeforeCancellation = observedJoinAdmissions.length;
    await assert.rejects(
      joinCurrentUserTeam(first.database, fifthSignUp.data.auth, fifthCode, { signal: cancelled.signal }),
      (error) => error.code === "TEAM_JOIN_DENIED",
    );
    assert.equal(observedJoinAdmissions.length, admissionsBeforeCancellation, "pre-cancelled admission never invokes Capsule policy");
    assert.equal(first.database.adapter.prepare(
      "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
    ).get(fifthCode.split(".")[1]).consumedAt, null, "cancelled admission leaves the Join link usable");
    assert.equal((await joinCurrentUserTeam(first.database, fifthSignUp.data.auth, fifthCode)).team.memberCount, 4);

    await first.database.adapter.prepare("UPDATE [seatPolicies] SET [maximumMembers] = ? WHERE [id] = ?").run(5, "seat-policy");
    sixthRecipient = await first.open();
    const sixthSignUp = await signUp(sixthRecipient, "admission-sixth", "admission-sixth@example.com", "Sixth Recipient");
    const sixthCode = await issue("admission-sixth-link", "admission-sixth@example.com");
    admissionFailureMessage = `protected policy failure ${team.id}`;
    const failedPolicy = await send(sixthRecipient, {
      id: "admission-policy-failure", type: "teams.join", code: sixthCode, sessionToken: sixthSignUp.data.sessionToken,
    });
    admissionFailureMessage = null;
    assert.deepEqual(failedPolicy.error, {
      code: "TEAM_JOIN_DENIED", message: "Could not join this Team.", hint: "Ask a Team administrator for access.",
    });
    assertNoTeamLeak(failedPolicy, [team.id, sixthCode, "protected policy failure"]);
    assert.equal(first.database.adapter.prepare(
      "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
    ).get(sixthCode.split(".")[1]).consumedAt, null, "failed admission leaves the Join link usable");
    assert.equal((await joinCurrentUserTeam(first.database, sixthSignUp.data.auth, sixthCode)).team.memberCount, 5);
  } finally {
    admissionFailureMessage = null;
    leakedAdmissionTable = null;
    owner?.close(); firstRecipient?.close(); secondRecipient?.close(); thirdRecipient?.close(); fifthRecipient?.close(); sixthRecipient?.close();
    await second?.close();
    await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Capsule Team admission cannot replace the joining identity and late cancellation rolls back the Join", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-admission-boundary-"));
  const runtime = await startRuntime(path.join(dir, "data.db"), admissionCapsule);
  let owner;
  let recipient;
  let other;
  let cancelledRecipient;
  const originalAdmission = runtime.database.runTeamJoinAdmission;
  const originalWithTransaction = runtime.database.adapter.withTransaction;
  let releaseAdmissionLogWriteResolve = () => {};
  try {
    owner = await runtime.open();
    recipient = await runtime.open();
    other = await runtime.open();
    cancelledRecipient = await runtime.open();
    const ownerSignUp = await signUp(owner, "boundary-owner", "boundary-owner@example.com", "Boundary Owner");
    const recipientSignUp = await signUp(recipient, "boundary-recipient", "boundary-recipient@example.com", "Boundary Recipient");
    const otherSignUp = await signUp(other, "boundary-other", "boundary-other@example.com", "Boundary Other");
    const cancelledSignUp = await signUp(cancelledRecipient, "boundary-cancelled", "boundary-cancelled@example.com", "Boundary Cancelled");
    const team = (await send(owner, { id: "boundary-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const now = new Date().toISOString();
    await runtime.database.adapter.prepare(
      "INSERT INTO [seatPolicies] ([id], [createdAt], [updatedAt], [teamId], [maximumMembers]) VALUES (?, ?, ?, ?, ?)",
    ).run("boundary-policy", now, now, team.id, 4);
    const issue = async (id, email) => {
      const result = await send(owner, { id, type: "teams.createJoinLink", teamId: team.id, email, ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken });
      assert.equal(result.error, null, JSON.stringify(result.error));
      return new URL(result.data.link).searchParams.get("code");
    };

    const recipientCode = await issue("boundary-recipient-link", "boundary-recipient@example.com");
    admissionAuthMutationTarget = otherSignUp.data.auth.userId;
    admissionAuthMutationRejected = false;
    let admissionLogWriteStartedResolve;
    const admissionLogWriteStarted = new Promise((resolve) => { admissionLogWriteStartedResolve = resolve; });
    const releaseAdmissionLogWrite = new Promise((resolve) => { releaseAdmissionLogWriteResolve = resolve; });
    runtime.database.adapter.withTransaction = function (callback) {
      return originalWithTransaction.call(this, (transactionAdapter) => {
        const originalInsertLogIndexEvent = transactionAdapter.insertLogIndexEvent;
        transactionAdapter.insertLogIndexEvent = function (event) {
          const result = originalInsertLogIndexEvent.call(this, event);
          if (event.message !== "Team join admission checked") return result;
          admissionLogWriteStartedResolve();
          return Promise.resolve(result).then(async (value) => {
            await releaseAdmissionLogWrite;
            return value;
          });
        };
        return callback(transactionAdapter);
      });
    };
    const recipientJoin = joinCurrentUserTeam(runtime.database, recipientSignUp.data.auth, recipientCode);
    await admissionLogWriteStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => leakedAdmissionTable.all(),
      (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE",
      "trusted admission reads revoke before pending transaction log writes settle",
    );
    releaseAdmissionLogWriteResolve();
    await recipientJoin;
    runtime.database.adapter.withTransaction = originalWithTransaction;
    assert.equal(admissionAuthMutationRejected, true, "the admission auth snapshot is immutable");
    assert.equal(runtime.database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
    ).get(team.id, recipientSignUp.data.auth.userId).count, 1, "membership belongs to the link recipient");
    assert.equal(runtime.database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
    ).get(team.id, otherSignUp.data.auth.userId).count, 0, "admission cannot substitute another user");
    admissionAuthMutationTarget = null;

    const cancelledCode = await issue("boundary-cancelled-link", "boundary-cancelled@example.com");
    const cancellation = new AbortController();
    let boundaryReachedResolve;
    let releaseBoundaryResolve;
    const boundaryReached = new Promise((resolve) => { boundaryReachedResolve = resolve; });
    const releaseBoundary = new Promise((resolve) => { releaseBoundaryResolve = resolve; });
    runtime.database.adapter.withTransaction = function (callback) {
      return originalWithTransaction.call(this, async (transactionAdapter) => {
        const result = await callback(transactionAdapter);
        const checks = transactionAdapter[Symbol.for("sporades.database.transactionBeforeCommitChecks")];
        checks?.unshift(async () => {
          boundaryReachedResolve();
          await releaseBoundary;
        });
        return result;
      });
    };
    const cancelledJoin = joinCurrentUserTeam(runtime.database, cancelledSignUp.data.auth, cancelledCode, { signal: cancellation.signal });
    await boundaryReached;
    cancellation.abort();
    releaseBoundaryResolve();
    await assert.rejects(
      cancelledJoin,
      (error) => error.code === "TEAM_JOIN_DENIED",
    );
    assert.equal(runtime.database.adapter.prepare(
      "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
    ).get(cancelledCode.split(".")[1]).consumedAt, null, "late cancellation rolls back link consumption");
    assert.equal(runtime.database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
    ).get(team.id, cancelledSignUp.data.auth.userId).count, 0, "late cancellation rolls back membership");

    runtime.database.adapter.withTransaction = originalWithTransaction;
    assert.equal((await joinCurrentUserTeam(runtime.database, cancelledSignUp.data.auth, cancelledCode)).team.memberCount, 3);
  } finally {
    releaseAdmissionLogWriteResolve();
    runtime.database.runTeamJoinAdmission = originalAdmission;
    runtime.database.adapter.withTransaction = originalWithTransaction;
    admissionAuthMutationTarget = null;
    admissionAuthMutationRejected = false;
    owner?.close(); recipient?.close(); other?.close(); cancelledRecipient?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Postgres Team admission serializes concurrent joins for the final seat", {
  skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres Team admission test.",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-admission-postgres-"));
  await withPostgresAdapter(async () => {}, { appTableNames: ["seatPolicies"] });
  const serverEnv = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const runtimeOptions = { serverEnv, config: { services: { database: { engine: "postgres" } } } };
  const first = await startRuntime(path.join(dir, "first.db"), admissionCapsule, runtimeOptions);
  let second;
  let owner;
  let firstRecipient;
  let secondRecipient;
  let thirdRecipient;
  try {
    owner = await first.open(); firstRecipient = await first.open(); secondRecipient = await first.open();
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ownerSignUp = await signUp(owner, "pg-admission-owner", `pg-owner-${unique}@example.com`, "Postgres Owner");
    const firstSignUp = await signUp(firstRecipient, "pg-admission-first", `pg-first-${unique}@example.com`, "Postgres First");
    const secondSignUp = await signUp(secondRecipient, "pg-admission-second", `pg-second-${unique}@example.com`, "Postgres Second");
    thirdRecipient = await first.open();
    const thirdSignUp = await signUp(thirdRecipient, "pg-admission-third", `pg-third-${unique}@example.com`, "Postgres Third");
    const team = (await send(owner, { id: "pg-admission-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const now = new Date().toISOString();
    await first.database.adapter.prepare(first.database.adapter.dialect.sql(
      "INSERT INTO [seatPolicies] ([id], [createdAt], [updatedAt], [teamId], [maximumMembers]) VALUES (?, ?, ?, ?, ?)",
    )).run(`pg-policy-${unique}`, now, now, team.id, 2);
    const issue = async (id, email) => {
      const result = await send(owner, { id, type: "teams.createJoinLink", teamId: team.id, email, ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken });
      assert.equal(result.error, null, JSON.stringify(result.error));
      return new URL(result.data.link).searchParams.get("code");
    };
    const [firstCode, secondCode] = await Promise.all([
      issue("pg-admission-first-link", firstSignUp.data.auth.email),
      issue("pg-admission-second-link", secondSignUp.data.auth.email),
    ]);
    second = await openDevDatabase(path.join(dir, "second.db"), "", serverEnv, {
      name: "teams-admission-test", auth: { providers: { anonymous: true, email: true } }, services: { database: { engine: "postgres" } },
    }, admissionCapsule, { serviceEnv: serverEnv });
    observedJoinAdmissions.length = 0;
    assert.deepEqual(await runQuery(first.database, firstSignUp.data.auth, "seatPolicies", [team.id]), { data: [], error: null });
    const attempts = await Promise.allSettled([
      joinCurrentUserTeam(first.database, firstSignUp.data.auth, firstCode),
      joinCurrentUserTeam(second, secondSignUp.data.auth, secondCode),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.find((attempt) => attempt.status === "rejected").reason.code, "TEAM_JOIN_DENIED");
    assert.deepEqual(observedJoinAdmissions.map((entry) => entry.currentMemberCount).sort(), [1, 2]);
    assert.equal(
      (await first.database.adapter.readRecentLogEvents(50)).filter(
        (entry) => entry.message === "Team join admission checked" && entry.data?.teamId === team.id,
      ).length,
      1,
      "only the admitted Postgres Join commits its transaction-scoped application log",
    );
    assert.throws(() => leakedAdmissionTable.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    const deniedCode = attempts[0].status === "rejected" ? firstCode : secondCode;
    const deniedLink = await first.database.adapter.prepare(first.database.adapter.dialect.sql(
      "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
    )).get(deniedCode.split(".")[1]);
    assert.equal(deniedLink.consumedAt, null, "Postgres denial rolls back link consumption");
    const count = await first.database.adapter.prepare(first.database.adapter.dialect.sql(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?",
    )).get(team.id);
    assert.equal(Number(count.count), 2);
    const thirdCode = await issue("pg-admission-third-link", thirdSignUp.data.auth.email);
    const sameTransaction = await runMutation(first.database, thirdSignUp.data.auth, "updateSeatPolicyAndJoin", [`pg-policy-${unique}`, 3, thirdCode]);
    assert.equal(sameTransaction.ok, true, JSON.stringify(sameTransaction));
    assert.equal(sameTransaction.data.team.memberCount, 3, "Postgres admission sees earlier writes in the mutation transaction");
  } finally {
    leakedAdmissionTable = null;
    owner?.close(); firstRecipient?.close(); secondRecipient?.close(); thirdRecipient?.close();
    await second?.close(); await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("libSQL Team admission serializes concurrent joins for the final seat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-admission-libsql-"));
  await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
    const serverEnv = {
      SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
      SPORADES_SERVICE_DATABASE_URL: url,
    };
    const runtimeOptions = { serverEnv, config: { services: { database: { kind: "database", engine: "libsql" } } } };
    const first = await startRuntime(path.join(dir, "first.db"), admissionCapsule, runtimeOptions);
    let second;
    let owner;
    let firstRecipient;
    let secondRecipient;
    let thirdRecipient;
    try {
      owner = await first.open(); firstRecipient = await first.open(); secondRecipient = await first.open();
      const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const ownerSignUp = await signUp(owner, "libsql-admission-owner", `libsql-owner-${unique}@example.com`, "libSQL Owner");
      const firstSignUp = await signUp(firstRecipient, "libsql-admission-first", `libsql-first-${unique}@example.com`, "libSQL First");
      const secondSignUp = await signUp(secondRecipient, "libsql-admission-second", `libsql-second-${unique}@example.com`, "libSQL Second");
      thirdRecipient = await first.open();
      const thirdSignUp = await signUp(thirdRecipient, "libsql-admission-third", `libsql-third-${unique}@example.com`, "libSQL Third");
      const team = (await send(owner, { id: "libsql-admission-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
      const now = new Date().toISOString();
      await first.database.adapter.prepare(first.database.adapter.dialect.sql(
        "INSERT INTO [seatPolicies] ([id], [createdAt], [updatedAt], [teamId], [maximumMembers]) VALUES (?, ?, ?, ?, ?)",
      )).run(`libsql-policy-${unique}`, now, now, team.id, 2);
      const issue = async (id, email) => {
        const result = await send(owner, { id, type: "teams.createJoinLink", teamId: team.id, email, ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken });
        assert.equal(result.error, null, JSON.stringify(result.error));
        return new URL(result.data.link).searchParams.get("code");
      };
      const [firstCode, secondCode] = await Promise.all([
        issue("libsql-admission-first-link", firstSignUp.data.auth.email),
        issue("libsql-admission-second-link", secondSignUp.data.auth.email),
      ]);
      second = await openDevDatabase(path.join(dir, "second.db"), "", serverEnv, {
        name: "teams-admission-test", auth: { providers: { anonymous: true, email: true } }, services: { database: { kind: "database", engine: "libsql" } },
      }, admissionCapsule, { serviceEnv: serverEnv });
      observedJoinAdmissions.length = 0;
      assert.deepEqual(await runQuery(first.database, firstSignUp.data.auth, "seatPolicies", [team.id]), { data: [], error: null });
      const attempts = await Promise.allSettled([
        joinCurrentUserTeam(first.database, firstSignUp.data.auth, firstCode),
        joinCurrentUserTeam(second, secondSignUp.data.auth, secondCode),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      assert.equal(attempts.find((attempt) => attempt.status === "rejected").reason.code, "TEAM_JOIN_DENIED");
      assert.deepEqual(observedJoinAdmissions.map((entry) => entry.currentMemberCount).sort(), [1, 2]);
      assert.equal(
        (await first.database.adapter.readRecentLogEvents(50)).filter(
          (entry) => entry.message === "Team join admission checked" && entry.data?.teamId === team.id,
        ).length,
        1,
        "only the admitted libSQL Join commits its transaction-scoped application log",
      );
      assert.throws(() => leakedAdmissionTable.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
      const deniedCode = attempts[0].status === "rejected" ? firstCode : secondCode;
      const deniedLink = await first.database.adapter.prepare(first.database.adapter.dialect.sql(
        "SELECT [consumedAt] FROM [sporades_team_join_links] WHERE [selector] = ?",
      )).get(deniedCode.split(".")[1]);
      assert.equal(deniedLink.consumedAt, null, "libSQL denial rolls back link consumption");
      const count = await first.database.adapter.prepare(first.database.adapter.dialect.sql(
        "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?",
      )).get(team.id);
      assert.equal(Number(count.count), 2);
      const thirdCode = await issue("libsql-admission-third-link", thirdSignUp.data.auth.email);
      const sameTransaction = await runMutation(first.database, thirdSignUp.data.auth, "updateSeatPolicyAndJoin", [`libsql-policy-${unique}`, 3, thirdCode]);
      assert.equal(sameTransaction.ok, true, JSON.stringify(sameTransaction));
      assert.equal(sameTransaction.data.team.memberCount, 3, "libSQL admission sees earlier writes in the mutation transaction");
    } finally {
      leakedAdmissionTable = null;
      owner?.close(); firstRecipient?.close(); secondRecipient?.close(); thirdRecipient?.close();
      await second?.close(); await first.close();
    }
  });
  await rm(dir, { recursive: true, force: true });
});

test("Team admins manage promotion, demotion, removal, leaving, and sole-member deletion through browser and trusted seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-lifecycle-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let firstMember;
  let secondMember;
  try {
    owner = await runtime.open();
    firstMember = await runtime.open();
    secondMember = await runtime.open();
    const ownerSignUp = await signUp(owner, "lifecycle-owner", "lifecycle-owner@example.com", "Lifecycle Owner");
    const firstSignUp = await signUp(firstMember, "lifecycle-first", "lifecycle-first@example.com", "First Member");
    const secondSignUp = await signUp(secondMember, "lifecycle-second", "lifecycle-second@example.com", "Second Member");
    const firstMemberSingleton = (await send(firstMember, {
      id: "lifecycle-first-singleton", type: "teams.list", sessionToken: firstSignUp.data.sessionToken,
    })).data.teams;
    assert.equal(firstMemberSingleton.length, 1);
    const team = (await send(owner, { id: "lifecycle-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];

    for (const [id, email, token] of [["lifecycle-first-link", "lifecycle-first@example.com", firstSignUp.data.sessionToken], ["lifecycle-second-link", "lifecycle-second@example.com", secondSignUp.data.sessionToken]]) {
      const issued = await send(owner, { id, type: "teams.createJoinLink", teamId: team.id, email, ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken });
      const recipient = email === "lifecycle-first@example.com" ? firstMember : secondMember;
      const joined = await send(recipient, { id: `${id}-join`, type: "teams.join", code: new URL(issued.data.link).searchParams.get("code"), sessionToken: token });
      assert.equal(joined.error, null, JSON.stringify(joined.error));
    }
    const afterJoinCount = await send(firstMember, { id: "lifecycle-after-join-count", type: "teams.countMembers", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.deepEqual(afterJoinCount, { id: "lifecycle-after-join-count", type: "teams.countMembers.result", data: { totalCount: 3 }, error: null });

    const promoted = await sendWithTimeout(owner, { id: "lifecycle-promote", type: "teams.promote", teamId: team.id, userId: firstSignUp.data.auth.userId });
    assert.deepEqual(promoted, { id: "lifecycle-promote", type: "teams.promote.result", data: { updated: true }, error: null });
    assert.deepEqual(await runMutation(runtime.database, firstSignUp.data.auth, "demoteTeamMember", [team.id, ownerSignUp.data.auth.userId]), { ok: true, data: { updated: true }, error: null });

    const removed = await send(secondMember, { id: "lifecycle-removed", type: "teams.removeMember", teamId: team.id, userId: secondSignUp.data.auth.userId, sessionToken: secondSignUp.data.sessionToken });
    assert.equal(removed.error.code, "DENIED", "ordinary members cannot remove themselves or others");
    const removedByAdmin = await send(firstMember, { id: "lifecycle-remove", type: "teams.removeMember", teamId: team.id, userId: secondSignUp.data.auth.userId, sessionToken: firstSignUp.data.sessionToken });
    assert.deepEqual(removedByAdmin, { id: "lifecycle-remove", type: "teams.removeMember.result", data: { removed: true }, error: null });
    const afterRemoval = await send(firstMember, { id: "lifecycle-after-remove", type: "teams.listMembers", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.equal(afterRemoval.data.totalCount, 2, "admin removal frees committed capacity immediately");
    const afterRemovalCount = await send(firstMember, { id: "lifecycle-after-remove-count", type: "teams.countMembers", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.deepEqual(afterRemovalCount, { id: "lifecycle-after-remove-count", type: "teams.countMembers.result", data: { totalCount: 2 }, error: null });

    const left = await send(owner, { id: "lifecycle-leave", type: "teams.leave", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.deepEqual(left, { id: "lifecycle-leave", type: "teams.leave.result", data: { left: true }, error: null });
    const afterLeave = await send(firstMember, { id: "lifecycle-after-leave", type: "teams.listMembers", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.equal(afterLeave.data.totalCount, 1, "leave frees committed capacity immediately");
    const afterLeaveCount = await send(firstMember, { id: "lifecycle-after-leave-count", type: "teams.countMembers", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.deepEqual(afterLeaveCount, { id: "lifecycle-after-leave-count", type: "teams.countMembers.result", data: { totalCount: 1 }, error: null });
    const lastAdminDemotion = await send(firstMember, { id: "lifecycle-last-demotion", type: "teams.demote", teamId: team.id, userId: firstSignUp.data.auth.userId, sessionToken: firstSignUp.data.sessionToken });
    assert.equal(lastAdminDemotion.error.code, "DENIED");
    const lastAdminLeave = await send(firstMember, { id: "lifecycle-last-leave", type: "teams.leave", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.equal(lastAdminLeave.error.code, "DENIED");
    assert.deepEqual(await runMutation(runtime.database, firstSignUp.data.auth, "deleteOwnedTeam", [team.id]), { ok: true, data: { deleted: true }, error: null });
    const deletedCount = await send(firstMember, { id: "lifecycle-after-delete-count", type: "teams.countMembers", teamId: team.id, sessionToken: firstSignUp.data.sessionToken });
    assert.deepEqual(deletedCount, {
      id: "lifecycle-after-delete-count",
      type: "error",
      data: null,
      error: { code: "DENIED", message: "Could not read this Team's member count.", hint: "Sign in as a current Team member and retry." },
    });
    const afterDelete = (await send(firstMember, { id: "lifecycle-after-delete", type: "teams.list", sessionToken: firstSignUp.data.sessionToken })).data;
    assert.deepEqual(afterDelete, { teams: firstMemberSingleton }, "deleting an unrelated sole-member Team preserves the caller's existing singleton without recreating the deleted Team");
    assert.ok(!afterDelete.teams.some((entry) => entry.id === team.id), "bootstrap history prevents deleted singleton Team recreation");
  } finally {
    owner?.close(); firstMember?.close(); secondMember?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser Team deletion and Join redemption leave no orphan Team state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-public-delete-join-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let recipient;
  try {
    owner = await runtime.open();
    recipient = await runtime.open();
    const ownerSignUp = await signUp(owner, "public-delete-owner", "public-delete-owner@example.com", "Owner");
    const recipientSignUp = await signUp(recipient, "public-delete-recipient", "public-delete-recipient@example.com", "Recipient");
    const team = (await send(owner, { id: "public-delete-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const issued = await send(owner, {
      id: "public-delete-issue", type: "teams.createJoinLink", teamId: team.id,
      email: "public-delete-recipient@example.com", ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    const code = new URL(issued.data.link).searchParams.get("code");

    const [deleted, joined] = await Promise.all([
      send(owner, { id: "public-delete", type: "teams.delete", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken }),
      send(recipient, { id: "public-delete-join", type: "teams.join", code, sessionToken: recipientSignUp.data.sessionToken }),
    ]);
    assert.equal([deleted, joined].filter((result) => result.error === null).length, 1, JSON.stringify({ deleted, joined }));
    assert.equal(runtime.database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] [m] LEFT JOIN [sporades_teams] [t] ON [t].[id] = [m].[teamId] WHERE [t].[id] IS NULL",
    ).get().count, 0);
    assert.equal(runtime.database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_redemptions] [r] LEFT JOIN [sporades_team_join_links] [l] ON [l].[id] = [r].[joinLinkId] WHERE [l].[id] IS NULL",
    ).get().count, 0);
    assert.equal(runtime.database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_counters] [c] LEFT JOIN [sporades_teams] [t] ON [t].[id] = [c].[teamId] WHERE [t].[id] IS NULL",
    ).get().count, 0);
  } finally {
    owner?.close(); recipient?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rolled-back trusted Team deletion emits no success audit and preserves the Team", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-delete-rollback-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  const auth = { userId: "delete-rollback-user", displayName: "Rollback", email: "delete-rollback@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
  const baseAdapter = runtime.database.adapter;
  try {
    await baseAdapter.withTransaction((tx) => tx.linkAuthUser({
      id: auth.userId, displayName: auth.displayName, email: auth.email, picture: null,
      isAuthenticated: 1, isGuest: 0, provider: "email",
    }));
    const team = (await runQuery(runtime.database, auth, "ownTeams")).data.teams[0];
    runtime.database.mutationHooks.afterMutation = ["() => { throw new Error('post-delete rollback'); }"];
    const result = await runMutation(runtime.database, auth, "deleteOwnedTeam", [team.id]);
    assert.equal(result.ok, false);
    assert.equal(baseAdapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [id] = ?").get(team.id).count, 1);
    assert.equal(baseAdapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?").get(team.id).count, 1);
    assert.equal((await runtime.database.log.tail(20)).some((event) => event.event === "teams.deleted"), false, "success audits flush only after commit");
  } finally {
    runtime.database.mutationHooks.afterMutation = [];
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a valid Join link with a mismatched email stays publicly generic while its denied audit retains the Team ID", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-join-mismatch-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  let owner;
  let recipient;
  try {
    owner = await runtime.open();
    recipient = await runtime.open();
    const ownerSignUp = await signUp(owner, "join-mismatch-owner", "owner@example.com", "Owner");
    const recipientSignUp = await signUp(recipient, "join-mismatch-recipient", "recipient@example.com", "Recipient");
    const team = (await send(owner, { id: "join-mismatch-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const issued = await send(owner, {
      id: "join-mismatch-issue", type: "teams.createJoinLink", teamId: team.id,
      email: "someone-else@example.com", ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    const code = new URL(issued.data.link).searchParams.get("code");

    const result = await send(recipient, {
      id: "join-mismatch", type: "teams.join", code, sessionToken: recipientSignUp.data.sessionToken,
    });
    assert.equal(result.type, "error");
    assert.deepEqual(result.error, {
      code: "INVALID_JOIN_LINK",
      message: "Join link is invalid.",
      hint: "Use a current Join link for this linked account.",
    });
    assertNoTeamLeak(result, [team.id, code, "someone-else@example.com"]);

    const audit = (await runtime.database.log.tail(20)).find((event) =>
      event.event === "teams.joinLink.join" && event.data.actorUserId === recipientSignUp.data.auth.userId && event.data.code === "INVALID_JOIN_LINK",
    );
    assert.deepEqual(audit.data, {
      operation: "teams.join", outcome: "denied", code: "INVALID_JOIN_LINK", actorUserId: recipientSignUp.data.auth.userId, teamId: team.id,
    });
    assertNoTeamLeak(audit, [code, "someone-else@example.com"]);
  } finally {
    owner?.close(); recipient?.close();
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

test("declared application roles are membership-scoped, atomic, safe, and available through browser and trusted Team APIs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-roles-"));
  const runtime = await startRuntime(path.join(dir, "data.db"), rolesCapsule);
  let admin;
  let member;
  let stranger;
  let anonymous;
  try {
    admin = await runtime.open(); member = await runtime.open(); stranger = await runtime.open(); anonymous = await runtime.open();
    const adminSignUp = await signUp(admin, "roles-admin", "roles-admin@example.com", "Admin");
    const memberSignUp = await signUp(member, "roles-member", "roles-member@example.com", "Member");
    const strangerSignUp = await signUp(stranger, "roles-stranger", "roles-stranger@example.com", "Stranger");
    const team = (await send(admin, { id: "roles-list", type: "teams.list", sessionToken: adminSignUp.data.sessionToken })).data.teams[0];
    await runtime.database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(team.id, memberSignUp.data.auth.userId, new Date().toISOString());

    const assigned = await send(admin, { id: "roles-assign", type: "teams.updateApplicationRoles", teamId: team.id, userId: memberSignUp.data.auth.userId, add: ["author", "reviewer"], remove: [], sessionToken: adminSignUp.data.sessionToken });
    assert.equal(assigned.error, null, JSON.stringify(assigned.error));
    assert.deepEqual(assigned.data, { updated: true });
    const members = await send(admin, { id: "roles-members", type: "teams.listMembers", teamId: team.id, sessionToken: adminSignUp.data.sessionToken });
    assert.deepEqual(members.data.members.find((entry) => entry.userId === memberSignUp.data.auth.userId).applicationRoles, ["author", "reviewer"]);
    const own = await send(member, { id: "roles-own", type: "teams.list", sessionToken: memberSignUp.data.sessionToken });
    assert.deepEqual(own.data.teams.find((entry) => entry.id === team.id).applicationRoles, ["author", "reviewer"]);
    assert.deepEqual((await runQuery(runtime.database, adminSignUp.data.auth, "roleMembers")).data, members.data, "trusted Team listing projects the same active roles");

    const trustedRemoval = await runMutation(runtime.database, adminSignUp.data.auth, "updateMemberRoles", [team.id, memberSignUp.data.auth.userId, { add: [], remove: ["reviewer"] }]);
    assert.deepEqual(trustedRemoval, { ok: true, data: { updated: true }, error: null }, "trusted handlers use the same transactional role operation");
    const mixed = await send(admin, { id: "roles-mixed", type: "teams.updateApplicationRoles", teamId: team.id, userId: memberSignUp.data.auth.userId, add: ["reviewer"], remove: ["author"], sessionToken: adminSignUp.data.sessionToken });
    assert.deepEqual(mixed, { id: "roles-mixed", type: "teams.updateApplicationRoles.result", data: { updated: true }, error: null }, "the browser seam accepts one successful mixed add/remove patch");
    const afterMixed = await send(admin, { id: "roles-after-mixed", type: "teams.listMembers", teamId: team.id, sessionToken: adminSignUp.data.sessionToken });
    assert.deepEqual(afterMixed.data.members.find((entry) => entry.userId === memberSignUp.data.auth.userId).applicationRoles, ["reviewer"]);

    const second = await send(admin, { id: "roles-second-team", type: "teams.create", name: "Role Scope Two", sessionToken: adminSignUp.data.sessionToken });
    assert.equal(second.error, null, JSON.stringify(second.error));
    await runtime.database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)").run(second.data.team.id, memberSignUp.data.auth.userId, new Date().toISOString());
    const secondAssignment = await send(admin, { id: "roles-second-assignment", type: "teams.updateApplicationRoles", teamId: second.data.team.id, userId: memberSignUp.data.auth.userId, add: ["author"], remove: [], sessionToken: adminSignUp.data.sessionToken });
    assert.equal(secondAssignment.error, null, JSON.stringify(secondAssignment.error));
    const scoped = await send(member, { id: "roles-scoped-own", type: "teams.list", sessionToken: memberSignUp.data.sessionToken });
    assert.deepEqual(scoped.data.teams.find((entry) => entry.id === team.id).applicationRoles, ["reviewer"], "the first membership retains its distinct role");
    assert.deepEqual(scoped.data.teams.find((entry) => entry.id === second.data.team.id).applicationRoles, ["author"], "the same user has a different role in a second Team");

    const unauthenticated = await send(anonymous, {
      id: "roles-unauthenticated",
      type: "teams.updateApplicationRoles",
      teamId: team.id,
      userId: memberSignUp.data.auth.userId,
      add: ["author"],
      remove: [],
    });
    assert.equal(unauthenticated.type, "error");
    assert.equal(unauthenticated.data, null);
    assert.equal(unauthenticated.error.code, "UNAUTHENTICATED");
    assertNoTeamLeak(unauthenticated, [team.id, memberSignUp.data.auth.userId, "roles-member@example.com", "Member", "author", "reviewer"]);

    const rejected = await send(admin, { id: "roles-overlap", type: "teams.updateApplicationRoles", teamId: team.id, userId: memberSignUp.data.auth.userId, add: ["author"], remove: ["author"], sessionToken: adminSignUp.data.sessionToken });
    assert.equal(rejected.error.code, "INVALID_APPLICATION_ROLES");
    const malformedPatches = [
      { id: "roles-missing-remove", add: ["author"] },
      { id: "roles-non-array-add", add: "author", remove: [] },
    ];
    for (const malformed of malformedPatches) {
      const response = await send(admin, {
        ...malformed,
        type: "teams.updateApplicationRoles",
        teamId: team.id,
        userId: memberSignUp.data.auth.userId,
        sessionToken: adminSignUp.data.sessionToken,
      });
      assert.equal(response.type, "error");
      assert.equal(response.data, null);
      assert.deepEqual(response.error, {
        code: "INVALID_APPLICATION_ROLES",
        message: "Invalid Team application-role update.",
        hint: "Use non-overlapping add and remove arrays of at most 16 declared roles.",
      }, "malformed raw payloads receive the same generic rejection");
      assertNoTeamLeak(response, [team.id, memberSignUp.data.auth.userId, "roles-member@example.com", "Member", "author", "reviewer"]);
    }
    const afterRejected = await send(admin, { id: "roles-after-rejected", type: "teams.listMembers", teamId: team.id, sessionToken: adminSignUp.data.sessionToken });
    assert.deepEqual(afterRejected.data.members.find((entry) => entry.userId === memberSignUp.data.auth.userId).applicationRoles, ["reviewer"], "unauthenticated and malformed browser patches leave no partial writes");
    const undeclared = await send(admin, { id: "roles-undeclared", type: "teams.updateApplicationRoles", teamId: team.id, userId: memberSignUp.data.auth.userId, add: ["unknown"], remove: [], sessionToken: adminSignUp.data.sessionToken });
    assert.equal(undeclared.error.code, "INVALID_APPLICATION_ROLES");
    const unknownTeam = await send(admin, { id: "roles-unknown-team", type: "teams.updateApplicationRoles", teamId: "00000000-0000-4000-8000-000000000000", userId: memberSignUp.data.auth.userId, add: ["author"], remove: [], sessionToken: adminSignUp.data.sessionToken });
    assert.equal(unknownTeam.error.code, "DENIED");
    const nonMember = await send(admin, { id: "roles-non-member", type: "teams.updateApplicationRoles", teamId: team.id, userId: strangerSignUp.data.auth.userId, add: ["author"], remove: [], sessionToken: adminSignUp.data.sessionToken });
    assert.equal(nonMember.error.code, "DENIED");
    const ordinarySelf = await send(member, { id: "roles-ordinary-self", type: "teams.updateApplicationRoles", teamId: team.id, userId: memberSignUp.data.auth.userId, add: ["author"], remove: [], sessionToken: memberSignUp.data.sessionToken });
    assert.equal(ordinarySelf.error.code, "DENIED");
    const denied = await send(stranger, { id: "roles-denied", type: "teams.updateApplicationRoles", teamId: team.id, userId: memberSignUp.data.auth.userId, add: ["author"], remove: [], sessionToken: strangerSignUp.data.sessionToken });
    assert.equal(denied.error.code, "DENIED", "an admin of a different Team cannot change this Team");
    assertNoTeamLeak(denied, [team.id, memberSignUp.data.auth.userId, "roles-member@example.com"]);

    const promoted = await send(admin, { id: "roles-promote", type: "teams.promote", teamId: team.id, userId: memberSignUp.data.auth.userId, sessionToken: adminSignUp.data.sessionToken });
    assert.equal(promoted.error, null, JSON.stringify(promoted.error));
    const afterAdminChange = await send(admin, { id: "roles-admin-change", type: "teams.listMembers", teamId: team.id, sessionToken: adminSignUp.data.sessionToken });
    assert.deepEqual(afterAdminChange.data.members.find((entry) => entry.userId === memberSignUp.data.auth.userId).applicationRoles, ["reviewer"], "management-role changes never alter application roles");
  } finally {
    admin?.close(); member?.close(); stranger?.close(); anonymous?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed Job enqueue rolls back its Team mutation and success audit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-audit-flush-"));
  const runtime = await startRuntime(path.join(dir, "data.db"));
  const auth = { userId: "team-audit-user", displayName: "Audit", email: "audit@example.com", picture: "https://example.com/audit.png", isAuthenticated: true, isGuest: false, provider: "email" };
  const baseAdapter = runtime.database.adapter;
  try {
    await baseAdapter.withTransaction((tx) => tx.linkAuthUser({ id: auth.userId, displayName: auth.displayName, email: auth.email, picture: auth.picture, isAuthenticated: 1, isGuest: 0, provider: auth.provider }));
    runtime.database.adapter = failPendingJobInsert(baseAdapter);
    const result = await runMutation(runtime.database, auth, "createAndQueue", ["Rolled back with queue failure"]);
    assert.equal(result.ok, false);
    assert.equal(countTeams(baseAdapter), 0, "the Team creation shares the failed Job enqueue transaction");
    assert.equal(Number(baseAdapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_jobs]").get().count), 0, "the failed enqueue leaves no Job row");
    assert.equal((await runtime.database.log.tail(20)).filter((event) => event.event === "teams.created").length, 0, "a rolled-back Team mutation emits no success audit");
  } finally {
    runtime.database.adapter = baseAdapter;
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("normal File URLs, public URLs, and deletes honour explicit Team File ACLs without leaking private URLs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-file-acl-"));
  const runtime = await startRuntime(path.join(dir, "data.db"), fileAclCapsule);
  let owner;
  let member;
  let admin;
  let author;
  let crossTeamMember;
  let anonymous;
  try {
    owner = await runtime.open();
    member = await runtime.open();
    admin = await runtime.open();
    author = await runtime.open();
    crossTeamMember = await runtime.open();
    anonymous = await runtime.open();

    const ownerSignUp = await signUp(owner, "file-owner", "file-owner@example.com", "Owner");
    const memberSignUp = await signUp(member, "file-member", "file-member@example.com", "Member");
    const adminSignUp = await signUp(admin, "file-admin", "file-admin@example.com", "Admin");
    const authorSignUp = await signUp(author, "file-author", "file-author@example.com", "Author");
    const crossTeamSignUp = await signUp(crossTeamMember, "file-cross-team", "file-cross-team@example.com", "Cross team");

    const teamA = (await send(owner, { id: "file-team-a", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    const teamB = (await send(owner, { id: "file-team-b", type: "teams.create", name: "Other team", sessionToken: ownerSignUp.data.sessionToken })).data.team;
    const join = async (id, teamId, email, recipient, sessionToken) => {
      const issued = await send(owner, { id: `${id}-issue`, type: "teams.createJoinLink", teamId, email, ttlSeconds: 300, sessionToken: ownerSignUp.data.sessionToken });
      assert.equal(issued.error, null, JSON.stringify(issued.error));
      const joined = await send(recipient, { id: `${id}-join`, type: "teams.join", code: new URL(issued.data.link).searchParams.get("code"), sessionToken });
      assert.equal(joined.error, null, JSON.stringify(joined.error));
    };
    await join("file-member", teamA.id, "file-member@example.com", member, memberSignUp.data.sessionToken);
    await join("file-admin", teamA.id, "file-admin@example.com", admin, adminSignUp.data.sessionToken);
    await join("file-author", teamA.id, "file-author@example.com", author, authorSignUp.data.sessionToken);
    await join("file-cross-team", teamB.id, "file-cross-team@example.com", crossTeamMember, crossTeamSignUp.data.sessionToken);

    const promoted = await send(owner, { id: "file-promote", type: "teams.promote", teamId: teamA.id, userId: adminSignUp.data.auth.userId, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(promoted.error, null, JSON.stringify(promoted.error));
    const assigned = await send(owner, { id: "file-author-role", type: "teams.updateApplicationRoles", teamId: teamA.id, userId: authorSignUp.data.auth.userId, add: ["author"], remove: [], sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(assigned.error, null, JSON.stringify(assigned.error));

    const upload = async (id, label) => {
      const pathName = `/teams/${teamA.id}/${label}.txt`;
      const negotiated = await send(owner, {
        id: `${id}-upload`, type: "file.uploadUrl", sessionToken: ownerSignUp.data.sessionToken,
        file: { name: `${label}.txt`, type: "text/plain", path: pathName, size: label.length },
      });
      assert.equal(negotiated.error, null, JSON.stringify(negotiated.error));
      const completed = await fetch(new URL(negotiated.data.uploadUrl, runtime.baseUrl), { method: negotiated.data.method, body: label });
      assert.equal(completed.status, 200);
      const payload = await completed.json();
      assert.equal(payload.ok, true, JSON.stringify(payload.error));
      return payload.data.file;
    };
    const readable = await upload("member", "member");
    const anyRole = await upload("any-role", "any-role");
    const inactiveRole = await upload("inactive-role", "inactive-role");
    const publishable = await upload("admin", "admin");
    const deletable = await upload("author", "author");

    const ownerUrl = await send(owner, { id: "owner-url", type: "file.url", fileReference: readable.path, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(ownerUrl.error, null, JSON.stringify(ownerUrl.error));

    const memberUrl = await send(member, { id: "member-url", type: "file.url", fileReference: readable.path, sessionToken: memberSignUp.data.sessionToken });
    assert.equal(memberUrl.error, null, JSON.stringify(memberUrl.error));
    assert.equal(observedFileAclTeams, undefined, "File ACL must not receive mutable Team management");
    assert.doesNotMatch(memberUrl.data.url, /sessionToken|session-token/i);
    const memberRead = await fetch(new URL(memberUrl.data.url, runtime.baseUrl), { headers: { "x-sporades-session-token": memberSignUp.data.sessionToken } });
    assert.equal(memberRead.status, 200);
    assert.equal(await memberRead.text(), "member");

    for (const [id, type, fileReference, options] of [
      ["member-publish", "file.publicUrl.create", publishable.path, { noExpiry: true }],
      ["member-delete", "file.delete", readable.path, undefined],
    ]) {
      const denied = await send(member, { id, type, fileReference, ...(options ? { options } : {}), sessionToken: memberSignUp.data.sessionToken });
      assert.equal(denied.type, "error");
      assert.equal(denied.error.message, "File not found.");
    }

    const anyRoleUrl = await send(author, { id: "author-any-role-url", type: "file.url", fileReference: anyRole.path, sessionToken: authorSignUp.data.sessionToken });
    assert.equal(anyRoleUrl.error, null, JSON.stringify(anyRoleUrl.error));
    assert.equal((await fetch(new URL(anyRoleUrl.data.url, runtime.baseUrl), { headers: { "x-sporades-session-token": authorSignUp.data.sessionToken } })).status, 200);

    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_membership_application_roles] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'retired', ?)",
    ).run(teamA.id, memberSignUp.data.auth.userId, new Date().toISOString());
    const inactive = await send(member, { id: "inactive-role-url", type: "file.url", fileReference: inactiveRole.path, sessionToken: memberSignUp.data.sessionToken });
    assert.equal(inactive.type, "error");
    assert.equal(inactive.error.message, "File not found.");
    assertNoTeamLeak(inactive, [teamA.id, inactiveRole.path, "retired"]);

    const published = await send(admin, { id: "admin-public", type: "file.publicUrl.create", fileReference: publishable.path, options: { noExpiry: true }, sessionToken: adminSignUp.data.sessionToken });
    assert.equal(published.error, null, JSON.stringify(published.error));
    assert.doesNotMatch(published.data.publicUrl.url, /sessionToken|session-token/i);
    assert.equal((await fetch(new URL(published.data.publicUrl.url, runtime.baseUrl))).status, 200);
    assert.equal(
      runtime.database.adapter.prepare("SELECT [ownerId] FROM [sporades_file_public_urls] WHERE [id] = ?").get(published.data.publicUrl.id).ownerId,
      ownerSignUp.data.auth.userId,
      "an ACL-approved collaborator creates a URL revocable by the File owner",
    );
    const adminCannotRevoke = await send(admin, { id: "admin-revoke-public", type: "file.publicUrl.revoke", publicUrlId: published.data.publicUrl.id, sessionToken: adminSignUp.data.sessionToken });
    assert.equal(adminCannotRevoke.type, "error");
    assert.equal(adminCannotRevoke.error.message, "Public file URL not found.");
    const ownerRevoked = await send(owner, { id: "owner-revoke-public", type: "file.publicUrl.revoke", publicUrlId: published.data.publicUrl.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(ownerRevoked.error, null, JSON.stringify(ownerRevoked.error));
    assert.equal((await fetch(new URL(published.data.publicUrl.url, runtime.baseUrl))).status, 404);

    const deleted = await send(author, { id: "author-delete", type: "file.delete", fileReference: deletable.path, sessionToken: authorSignUp.data.sessionToken });
    assert.equal(deleted.error, null, JSON.stringify(deleted.error));
    assert.equal((await send(owner, { id: "owner-deleted", type: "file.url", fileReference: deletable.path, sessionToken: ownerSignUp.data.sessionToken })).error.message, "File not found.");

    const roleRemoved = await send(owner, { id: "remove-author-role", type: "teams.updateApplicationRoles", teamId: teamA.id, userId: authorSignUp.data.auth.userId, add: [], remove: ["author"], sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(roleRemoved.error, null, JSON.stringify(roleRemoved.error));
    const roleLost = await send(author, { id: "author-role-lost", type: "file.url", fileReference: anyRole.path, sessionToken: authorSignUp.data.sessionToken });
    assert.equal(roleLost.type, "error");
    assert.equal(roleLost.error.message, "File not found.");
    assert.equal((await fetch(new URL(anyRoleUrl.data.url, runtime.baseUrl), { headers: { "x-sporades-session-token": authorSignUp.data.sessionToken } })).status, 404, "a private HTTP URL is re-authorized after application-role removal");

    const memberRemoved = await send(owner, { id: "remove-file-member", type: "teams.removeMember", teamId: teamA.id, userId: memberSignUp.data.auth.userId, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(memberRemoved.error, null, JSON.stringify(memberRemoved.error));
    const memberLost = await send(member, { id: "member-removed-url", type: "file.url", fileReference: readable.path, sessionToken: memberSignUp.data.sessionToken });
    assert.equal(memberLost.type, "error");
    assert.equal(memberLost.error.message, "File not found.");
    assert.equal((await fetch(new URL(memberUrl.data.url, runtime.baseUrl), { headers: { "x-sporades-session-token": memberSignUp.data.sessionToken } })).status, 404, "a private HTTP URL is re-authorized after membership removal");

    for (const [id, socket, sessionToken] of [
      ["anonymous", anonymous, null],
      ["cross-team", crossTeamMember, crossTeamSignUp.data.sessionToken],
    ]) {
      const denied = await send(socket, { id: `${id}-private`, type: "file.url", fileReference: readable.path, ...(sessionToken ? { sessionToken } : {}) });
      assert.equal(denied.type, "error");
      assert.equal(denied.error.message, "File not found.");
      const publishDenied = await send(socket, { id: `${id}-publish`, type: "file.publicUrl.create", fileReference: publishable.path, options: { noExpiry: true }, ...(sessionToken ? { sessionToken } : {}) });
      assert.equal(publishDenied.type, "error");
      assert.equal(publishDenied.error.message, "File not found.");
      const deleteDenied = await send(socket, { id: `${id}-delete`, type: "file.delete", fileReference: readable.path, ...(sessionToken ? { sessionToken } : {}) });
      assert.equal(deleteDenied.type, "error");
      assert.equal(deleteDenied.error.message, "File not found.");
      const direct = await fetch(new URL(memberUrl.data.url, runtime.baseUrl), { headers: sessionToken ? { "x-sporades-session-token": sessionToken } : {} });
      assert.equal(direct.status, 404);
    }
  } finally {
    owner?.close(); member?.close(); admin?.close(); author?.close(); crossTeamMember?.close(); anonymous?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless Team Billing returns only policy-approved provider-free state and rechecks every request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-headless-team-billing-"));
  const runtime = await startRuntime(path.join(dir, "data.db"), billingCapsule);
  let owner;
  let nextHolder;
  let outsider;
  let anonymous;
  try {
    owner = await runtime.open();
    nextHolder = await runtime.open();
    outsider = await runtime.open();
    anonymous = await runtime.open();
    const ownerSignUp = await signUp(owner, "billing-owner-sign-up", "billing-owner@example.com", "Billing owner");
    const nextHolderSignUp = await signUp(nextHolder, "billing-next-sign-up", "billing-next@example.com", "Next holder");
    const outsiderSignUp = await signUp(outsider, "billing-outsider-sign-up", "billing-outsider@example.com", "Outsider");
    const team = (await send(owner, { id: "billing-team", type: "teams.list", sessionToken: ownerSignUp.data.sessionToken })).data.teams[0];
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)",
    ).run(team.id, nextHolderSignUp.data.auth.userId, new Date().toISOString());
    const holderSet = await send(owner, {
      id: "set-billing-holder",
      type: "mutation.run",
      mutation: "setBillingHolder",
      args: [team.id, ownerSignUp.data.auth.userId],
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(holderSet.error, null, JSON.stringify(holderSet.error));

    const inactive = await send(owner, { id: "billing-inactive", type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(inactive.error, null, JSON.stringify(inactive.error));
    assert.deepEqual(inactive.data, { state: "inactive", teamId: team.id });
    assert.deepEqual(billingPolicyChecks.at(-1).input, { operation: "read", teamId: team.id, teamRole: "admin" });
    assert.deepEqual(billingPolicyChecks.at(-1).contextKeys, ["auth", "db", "env", "log", "teams"]);
    assert.deepEqual(billingPolicyChecks.at(-1).tableKeys, ["all", "get", "limit", "orderBy", "where"]);
    assert.throws(() => capturedBillingPolicyTable.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    const reservedNamespace = await send(owner, {
      id: "billing-reserved-message",
      type: "app.send",
      message: "teamBilling.get",
      data: null,
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(reservedNamespace.error.message, "Reserved app message type: teamBilling.get");

    const now = new Date().toISOString();
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', ?, ?, ?)",
    ).run(team.id, "cus_private_123", now, now);
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt], [lastEventOccurredAt], [lastEventKind], [lastEventRank], [terminalLatch]) VALUES (?, ?, 'sandbox', ?, ?, 'agency', 7, 'active', 0, ?, ?, ?, ?, 'active', 20, 0)",
    ).run("sub-local-1", team.id, "sub_private_123", "price_test_agency", "2026-09-23T00:00:00.000Z", now, now, now);
    const active = await send(owner, { id: "billing-active", type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.deepEqual(active.data, {
      state: "active",
      teamId: team.id,
      productKey: "agency",
      quantity: 7,
      renewsAt: "2026-09-23T00:00:00.000Z",
    });
    assert.doesNotMatch(JSON.stringify(active), /cus_private|sub_private|price_test_agency|provider/i);

    for (const [column, privateValue] of [
      ["providerPriceId", "price_private_drift"],
      ["mode", "live"],
      ["currentPeriodEnd", "sub_private_timestamp_leak"],
      ["cancelAtPeriodEnd", 2],
    ]) {
      await runtime.database.adapter.prepare(
        `UPDATE [sporades_team_billing_subscriptions] SET [${column}] = ? WHERE [id] = ?`,
      ).run(privateValue, "sub-local-1");
      const drifted = await send(owner, { id: `billing-drift-${column}`, type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
      assert.deepEqual(drifted.data, {
        state: "attention-required",
        teamId: team.id,
        reason: ["currentPeriodEnd", "cancelAtPeriodEnd"].includes(column) ? "provider-state-ambiguous" : "catalogue-mismatch",
      });
      if (typeof privateValue === "string") {
        assert.doesNotMatch(JSON.stringify(drifted), new RegExp(privateValue, "i"));
      }
      const restored = column === "providerPriceId" ? "price_test_agency"
        : column === "mode" ? "sandbox"
          : column === "currentPeriodEnd" ? "2026-09-23T00:00:00.000Z" : 0;
      await runtime.database.adapter.prepare(
        `UPDATE [sporades_team_billing_subscriptions] SET [${column}] = ? WHERE [id] = ?`,
      ).run(restored, "sub-local-1");
    }

    await runtime.database.adapter.prepare(
      "UPDATE [sporades_team_billing_subscriptions] SET [productKey] = 'studio', [providerPriceId] = 'price_test_studio', [quantity] = 7 WHERE [id] = ?",
    ).run("sub-local-1");
    const fixedQuantityDrift = await send(owner, { id: "billing-fixed-quantity-drift", type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.deepEqual(fixedQuantityDrift.data, { state: "attention-required", teamId: team.id, reason: "catalogue-mismatch" });
    await runtime.database.adapter.prepare(
      "UPDATE [sporades_team_billing_subscriptions] SET [productKey] = 'agency', [providerPriceId] = 'price_test_agency', [quantity] = 7 WHERE [id] = ?",
    ).run("sub-local-1");

    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, 'checkout', 'agency', 'queued', NULL, ?, NULL, ?, ?)",
    ).run("op-local-1", "request-local-1", team.id, ownerSignUp.data.auth.userId, "idem-local-1", "cus_private_timestamp_leak", now);
    const malformedPending = await send(owner, { id: "billing-malformed-pending", type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.deepEqual(malformedPending.data, {
      state: "attention-required",
      teamId: team.id,
      reason: "provider-state-ambiguous",
    });
    assert.doesNotMatch(JSON.stringify(malformedPending), /cus_private_timestamp_leak/i);
    await runtime.database.adapter.prepare("DELETE FROM [sporades_team_billing_operations] WHERE [id] = ?").run("op-local-1");

    for (const [name, socket, sessionToken] of [
      ["anonymous", anonymous, null],
      ["cross-team", outsider, outsiderSignUp.data.sessionToken],
      ["non-holder-admin", nextHolder, nextHolderSignUp.data.sessionToken],
    ]) {
      const denied = await send(socket, { id: `billing-${name}`, type: "teamBilling.get", teamId: team.id, ...(sessionToken ? { sessionToken } : {}) });
      assert.equal(denied.type, "error");
      assert.equal(denied.error.code, "TEAM_BILLING_DENIED");
      assert.equal(denied.data, null);
      assert.doesNotMatch(JSON.stringify(denied), new RegExp(`${team.id}|agency|cus_|sub_|price_`, "i"));
    }

    const holderChanged = await send(owner, {
      id: "change-billing-holder",
      type: "mutation.run",
      mutation: "setBillingHolder",
      args: [team.id, nextHolderSignUp.data.auth.userId],
      sessionToken: ownerSignUp.data.sessionToken,
    });
    assert.equal(holderChanged.error, null, JSON.stringify(holderChanged.error));
    const formerHolder = await send(owner, { id: "billing-former-holder", type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignUp.data.sessionToken });
    assert.equal(formerHolder.error.code, "TEAM_BILLING_DENIED");
    const currentHolder = await send(nextHolder, { id: "billing-current-holder", type: "teamBilling.get", teamId: team.id, sessionToken: nextHolderSignUp.data.sessionToken });
    assert.deepEqual(currentHolder.data, active.data);

    await runtime.database.adapter.prepare("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?").run(team.id, nextHolderSignUp.data.auth.userId);
    const capturedSession = await send(nextHolder, { id: "billing-captured-session", type: "teamBilling.get", teamId: team.id, sessionToken: nextHolderSignUp.data.sessionToken });
    assert.equal(capturedSession.error.code, "TEAM_BILLING_DENIED");
  } finally {
    owner?.close(); nextHolder?.close(); outsider?.close(); anonymous?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless Team Checkout durably deduplicates work and exposes only an authorized short-lived continuation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-headless-team-checkout-"));
  const providerInputs = [];
  let blockNextProvider = false;
  let releaseBlockedProvider;
  let markBlockedProviderStarted;
  const blockedProviderStarted = new Promise((resolve) => { markBlockedProviderStarted = resolve; });
  const blockedProviderRelease = new Promise((resolve) => { releaseBlockedProvider = resolve; });
  let retryOnceOperationId = null;
  let failNextOperationOnce = false;
  let authorityRetryOperationId = null;
  let failNextOperationForAuthority = false;
  let markAuthorityFirstAttempt;
  const authorityFirstAttempt = new Promise((resolve) => { markAuthorityFirstAttempt = resolve; });
  let quantityRetryOperationId = null;
  let failNextOperationForQuantity = false;
  let markQuantityFirstAttempt;
  const quantityFirstAttempt = new Promise((resolve) => { markQuantityFirstAttempt = resolve; });
  let exhaustRetryOperationId = null;
  let failNextOperationToExhaust = false;
  const runtime = await startRuntime(path.join(dir, "data.db"), billingCapsule, {
    serverEnv: { STRIPE_SECRET_KEY: "sk_test_team_checkout", STRIPE_WEBHOOK_SECRET: "whsec_team_checkout" },
    config: {
      payments: { stripe: {
        enabled: true,
        secretKeyEnv: "STRIPE_SECRET_KEY",
        webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
        publicOrigin: "https://checkout.example.test",
        callbackPath: "/stripe/webhook",
        apiVersion: "2026-07-29.dahlia",
        livemode: false,
        requestTimeoutMs: 10_000,
      } },
    },
    runtimeOptions: {
      createStripeCallbackEndpoint,
      createStripeTeamBillingProvider: () => ({
        async create(input) {
          providerInputs.push(input);
          const suffix = providerInputs.length;
          if (blockNextProvider) {
            markBlockedProviderStarted();
            await blockedProviderRelease;
          }
          if (failNextOperationOnce && retryOnceOperationId === null) {
            retryOnceOperationId = input.operationId;
            const error = new Error("transient provider failure");
            error.retryable = true;
            throw error;
          }
          if (retryOnceOperationId === input.operationId) {
            failNextOperationOnce = false;
            retryOnceOperationId = null;
          }
          if (failNextOperationForAuthority && authorityRetryOperationId === null) {
            authorityRetryOperationId = input.operationId;
            markAuthorityFirstAttempt();
            const error = new Error("transient provider failure before authority transfer");
            error.retryable = true;
            throw error;
          }
          if (failNextOperationForQuantity && quantityRetryOperationId === null) {
            quantityRetryOperationId = input.operationId;
            markQuantityFirstAttempt();
            const error = new Error("transient provider failure before Team count change");
            error.retryable = true;
            throw error;
          }
          if (failNextOperationToExhaust && exhaustRetryOperationId === null) exhaustRetryOperationId = input.operationId;
          if (exhaustRetryOperationId === input.operationId) {
            const error = new Error("persistent transient provider failure");
            error.retryable = true;
            throw error;
          }
          return { ok: true, sessionId: `cs_test_team_checkout_${suffix}`, url: `https://checkout.stripe.com/c/pay/cs_test_team_checkout_${suffix}#fixture` };
        },
      }),
    },
  });
  let owner;
  let nextHolder;
  let quantityMember;
  try {
    await runtime.database.init();
    owner = await runtime.open();
    const signupResult = await signUp(owner, "checkout-owner-sign-up", "checkout-owner@example.com", "Checkout owner");
    const team = (await send(owner, { id: "checkout-team", type: "teams.list", sessionToken: signupResult.data.sessionToken })).data.teams[0];
    const holder = await send(owner, {
      id: "checkout-holder",
      type: "mutation.run",
      mutation: "setBillingHolder",
      args: [team.id, signupResult.data.auth.userId],
      sessionToken: signupResult.data.sessionToken,
    });
    assert.equal(holder.error, null, JSON.stringify(holder.error));
    await runtime.database.adapter.withTransaction(async (transaction) => {
      const createdAt = new Date().toISOString();
      for (let index = 1; index <= 99; index += 1) {
        const userId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        await transaction.prepare(
          "INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES (?, ?, ?, NULL, NULL, 1, 0, 'test')",
        ).run(userId, createdAt, `Seat ${index}`);
        await transaction.prepare(
          "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)",
        ).run(team.id, userId, createdAt);
      }
    });
    const input = { teamId: team.id, requestId: "55555555-5555-4555-8555-555555555555", productKey: "agency" };
    const started = await send(owner, { id: "checkout-start", type: "teamBilling.startCheckout", input, sessionToken: signupResult.data.sessionToken });
    assert.equal(started.data.state, "pending", JSON.stringify(started));
    const ready = await waitForTeamCheckout(owner, input, signupResult.data.sessionToken, "ready");
    assert.deepEqual(ready.data, {
      state: "ready",
      ...input,
      url: "https://checkout.stripe.com/c/pay/cs_test_team_checkout_1#fixture",
      expiresAt: ready.data.expiresAt,
    });
    assert.match(ready.data.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(providerInputs.length, 1);
    const expiryJob = await runtime.database.adapter.prepare(
      "SELECT [handler], [payload], [status], [availableAt] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-checkout-expiry'",
    ).get();
    assert.equal(expiryJob.handler, "_sporades.team-billing-checkout-expiry");
    assert.equal(expiryJob.status, "queued");
    assert.deepEqual(JSON.parse(expiryJob.payload), { operationId: providerInputs[0].operationId });
    assert.equal(expiryJob.availableAt, ready.data.expiresAt, "capability erasure is durably scheduled with its exposure deadline");
    assert.deepEqual({
      mode: providerInputs[0].mode,
      priceId: providerInputs[0].priceId,
      quantity: providerInputs[0].quantity,
      successPath: providerInputs[0].successPath,
      cancelPath: providerInputs[0].cancelPath,
      businessReference: providerInputs[0].businessReference,
    }, {
      mode: "subscription",
      priceId: "price_test_agency",
      quantity: 100,
      successPath: "/settings/billing/success",
      cancelPath: "/settings/billing/cancelled",
      businessReference: providerInputs[0].operationId,
    });
    assert.doesNotMatch(JSON.stringify(ready), /price_test_agency|idempotency|providerObject|sessionId/i, "the safe response contains only the approved URL capability, not provider correlation fields");
    const repeated = await send(owner, { id: "checkout-repeat", type: "teamBilling.startCheckout", input, sessionToken: signupResult.data.sessionToken });
    assert.equal(repeated.data.state, "ready");
    assert.equal(providerInputs.length, 1, "duplicate requests do not enqueue or call the provider twice");
    const conflict = await send(owner, { id: "checkout-conflict", type: "teamBilling.startCheckout", input: { ...input, productKey: "studio" }, sessionToken: signupResult.data.sessionToken });
    assert.equal(conflict.error.code, "TEAM_BILLING_REQUEST_CONFLICT");
    const billingTruth = await send(owner, { id: "checkout-no-entitlement", type: "teamBilling.get", teamId: team.id, sessionToken: signupResult.data.sessionToken });
    assert.deepEqual(billingTruth.data, { state: "inactive", teamId: team.id }, "a Checkout response never applies entitlement truth");

    const completedObservation = verifiedCheckoutObservation(providerInputs[0], "cs_test_team_checkout_1", "evt_team_checkout_completed_1", "checkout.session.completed");
    assert.deepEqual(await applyVerifiedTeamBillingCheckoutObservation(runtime.database, completedObservation), { applied: true });
    const completed = await send(owner, { id: "checkout-completed", type: "teamBilling.startCheckout", input, sessionToken: signupResult.data.sessionToken });
    assert.equal(completed.data.state, "completed");
    assert.equal("url" in completed.data, false);

    blockNextProvider = true;
    const eventFirstInput = { teamId: team.id, requestId: "66666666-6666-4666-8666-666666666666", productKey: "studio" };
    const eventFirstStarted = await send(owner, { id: "checkout-event-first", type: "teamBilling.startCheckout", input: eventFirstInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(eventFirstStarted.data.state, "pending");
    await waitForCheckoutSignal(blockedProviderStarted, "blocked provider start");
    const overlapping = await send(owner, {
      id: "checkout-overlapping",
      type: "teamBilling.startCheckout",
      input: { teamId: team.id, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", productKey: "agency" },
      sessionToken: signupResult.data.sessionToken,
    });
    assert.equal(overlapping.error.code, "TEAM_BILLING_CHECKOUT_ACTIVE");
    assert.equal(providerInputs.length, 2, "one Team cannot start a second provider Checkout while one is active");
    const eventFirstObservation = verifiedCheckoutObservation(providerInputs[1], "cs_test_team_checkout_2", "evt_team_checkout_completed_2", "checkout.session.completed");
    const mismatchedObjectObservation = { ...eventFirstObservation,
      providerEventId: "evt_team_checkout_mismatched_object",
      objectId: "cs_test_different",
      raw: { ...eventFirstObservation.raw, id: "evt_team_checkout_mismatched_object" },
    };
    assert.deepEqual(await applyVerifiedTeamBillingCheckoutObservation(runtime.database, mismatchedObjectObservation), { applied: false },
      "the normalized observation ID must match the verified Checkout object");
    const paymentModeObservation = { ...eventFirstObservation,
      providerEventId: "evt_team_checkout_payment_mode",
      raw: { ...eventFirstObservation.raw, id: "evt_team_checkout_payment_mode", data: { object: { ...eventFirstObservation.raw.data.object, mode: "payment" } } },
    };
    assert.deepEqual(await applyVerifiedTeamBillingCheckoutObservation(runtime.database, paymentModeObservation), { applied: false },
      "only subscription Checkout observations belong to Team Billing");
    assert.deepEqual(await applyVerifiedTeamBillingCheckoutObservation(runtime.database, eventFirstObservation), { applied: true });
    releaseBlockedProvider();
    const eventFirstCompleted = await waitForTeamCheckout(owner, eventFirstInput, signupResult.data.sessionToken, "completed");
    assert.equal("url" in eventFirstCompleted.data, false, "event-before-response never re-exposes a continuation");
    const stillNoEntitlement = await send(owner, { id: "checkout-still-no-entitlement", type: "teamBilling.get", teamId: team.id, sessionToken: signupResult.data.sessionToken });
    assert.deepEqual(stillNoEntitlement.data, { state: "attention-required", teamId: team.id, reason: "provider-state-ambiguous" },
      "malformed supported evidence remains fail-closed and Checkout completion still grants no entitlement");

    blockNextProvider = false;
    failNextOperationOnce = true;
    const retryInput = { teamId: team.id, requestId: "77777777-7777-4777-8777-777777777777", productKey: "agency" };
    const retryStarted = await send(owner, { id: "checkout-retry-start", type: "teamBilling.startCheckout", input: retryInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(retryStarted.data.state, "pending");
    const retryReady = await waitForTeamCheckout(owner, retryInput, signupResult.data.sessionToken, "ready", 4_000);
    assert.equal(retryReady.data.state, "ready");
    const retryOperationInputs = providerInputs.slice(-2);
    assert.equal(retryOperationInputs.length, 2);
    assert.equal(retryOperationInputs[0].idempotencyKey, retryOperationInputs[1].idempotencyKey);
    assert.deepEqual(
      { ...retryOperationInputs[0], idempotencyKey: "stable" },
      { ...retryOperationInputs[1], idempotencyKey: "stable" },
      "provider retry reuses byte-equivalent trusted parameters",
    );
    await runtime.database.adapter.prepare(
      "UPDATE [sporades_team_billing_operations] SET [continuationExpiresAt] = ? WHERE [teamId] = ? AND [requestId] = ?",
    ).run("2000-01-01T00:00:00.000Z", team.id, retryInput.requestId);
    await expireTeamBillingCheckout(runtime.database, {}, { operationId: retryOperationInputs[0].operationId });
    const expired = await send(owner, { id: "checkout-expired", type: "teamBilling.startCheckout", input: retryInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(expired.data.state, "expired");
    assert.equal("url" in expired.data, false);
    const expiredPrivate = await runtime.database.adapter.prepare(
      "SELECT [continuationUrl], [continuationExpiresAt] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
    ).get(team.id, retryInput.requestId);
    assert.deepEqual({ ...expiredPrivate }, { continuationUrl: null, continuationExpiresAt: null }, "expired capabilities are erased from runtime storage");
    quantityMember = await runtime.open();
    const quantityMemberSignup = await signUp(quantityMember, "checkout-quantity-member", "checkout-quantity@example.com", "Quantity member");
    failNextOperationForQuantity = true;
    const quantityInput = { teamId: team.id, requestId: "99999999-9999-4999-8999-999999999999", productKey: "agency" };
    const quantityStarted = await send(owner, { id: "checkout-quantity-start", type: "teamBilling.startCheckout", input: quantityInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(quantityStarted.data.state, "pending");
    await waitForCheckoutSignal(quantityFirstAttempt, "quantity retry first attempt");
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)",
    ).run(team.id, quantityMemberSignup.data.auth.userId, new Date().toISOString());
    const superseded = await waitForTeamCheckout(owner, quantityInput, signupResult.data.sessionToken, "superseded", 4_000);
    assert.equal(superseded.data.state, "superseded");
    assert.equal(providerInputs.filter((candidate) => candidate.operationId === quantityRetryOperationId).length, 1, "changed Team quantity supersedes before provider retry");
    failNextOperationToExhaust = true;
    const exhaustedInput = { teamId: team.id, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", productKey: "studio" };
    const exhaustedStarted = await send(owner, { id: "checkout-exhausted-start", type: "teamBilling.startCheckout", input: exhaustedInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(exhaustedStarted.data.state, "pending");
    const exhausted = await waitForTeamCheckout(owner, exhaustedInput, signupResult.data.sessionToken, "failed", 6_000);
    assert.equal(exhausted.data.reason, "unavailable");
    assert.equal(providerInputs.filter((candidate) => candidate.operationId === exhaustRetryOperationId).length, 4, "retry exhaustion terminally fails the operation after the reserved Job budget");
    const exhaustedJob = await runtime.database.adapter.prepare(
      "SELECT [id] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-checkout' AND [payload] = ?",
    ).get(JSON.stringify({ operationId: exhaustRetryOperationId }));
    const expiredLeaseAt = new Date(Date.now() - 1_000).toISOString();
    await runtime.database.adapter.prepare(
      "UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = 4, [leaseExpiresAt] = ?, [claimToken] = 'crashed-final-claim', [failure] = NULL, [failedAt] = NULL WHERE [id] = ?",
    ).run(expiredLeaseAt, exhaustedJob.id);
    await runtime.database.adapter.prepare(
      "UPDATE [sporades_team_billing_operations] SET [status] = 'running', [safeFailureCode] = NULL WHERE [id] = ?",
    ).run(exhaustRetryOperationId);
    await recoverExpiredJobLeases(runtime.database);
    const crashRecovered = await send(owner, { id: "checkout-crash-recovered", type: "teamBilling.startCheckout", input: exhaustedInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(crashRecovered.data.state, "failed", "an expired final Job lease terminally reconciles its Checkout operation after restart");
    failNextOperationToExhaust = false;
    nextHolder = await runtime.open();
    const nextHolderSignup = await signUp(nextHolder, "checkout-next-holder", "checkout-next@example.com", "Next checkout holder");
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)",
    ).run(team.id, nextHolderSignup.data.auth.userId, new Date().toISOString());
    failNextOperationForAuthority = true;
    const transferInput = { teamId: team.id, requestId: "88888888-8888-4888-8888-888888888888", productKey: "studio" };
    const transferStarted = await send(owner, { id: "checkout-transfer-start", type: "teamBilling.startCheckout", input: transferInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(transferStarted.data.state, "pending");
    await waitForCheckoutSignal(authorityFirstAttempt, "authority retry first attempt");
    const transferHolder = await send(owner, {
      id: "checkout-transfer-holder",
      type: "mutation.run",
      mutation: "setBillingHolder",
      args: [team.id, nextHolderSignup.data.auth.userId],
      sessionToken: signupResult.data.sessionToken,
    });
    assert.equal(transferHolder.error, null, JSON.stringify(transferHolder.error));
    const transferred = await waitForTeamCheckout(nextHolder, transferInput, nextHolderSignup.data.sessionToken, "failed", 4_000);
    assert.equal(transferred.data.reason, "authority-changed");
    const callsAfterTransfer = providerInputs.filter((candidate) => candidate.operationId === authorityRetryOperationId);
    assert.equal(callsAfterTransfer.length, 1, "authority transfer prevents the provider retry");
    const formerHolder = await send(owner, { id: "checkout-former-holder", type: "teamBilling.startCheckout", input: transferInput, sessionToken: signupResult.data.sessionToken });
    assert.equal(formerHolder.error.code, "TEAM_BILLING_DENIED");
  } finally {
    releaseBlockedProvider?.();
    owner?.close();
    nextHolder?.close();
    quantityMember?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless managed Plan transition stays pending through provider acknowledgement and completes only from verified Stripe truth", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-headless-team-plan-transition-"));
  const providerInputs = [];
  const runtime = await startRuntime(path.join(dir, "data.db"), billingCapsule, {
    serverEnv: { STRIPE_SECRET_KEY: "sk_test_team_plan", STRIPE_WEBHOOK_SECRET: "whsec_team_plan" },
    config: { payments: { stripe: {
      enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
      publicOrigin: "https://checkout.example.test", callbackPath: "/stripe/webhook",
      apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10_000,
    } } },
    runtimeOptions: {
      createStripeCallbackEndpoint,
      createStripeTeamBillingProvider: () => ({
        async updateManagedSubscription(input) {
          providerInputs.push(input);
          return { ok: true, outcome: "acknowledged" };
        },
      }),
    },
  });
  let owner; let member;
  try {
    await runtime.database.init();
    owner = await runtime.open();
    member = await runtime.open();
    const ownerSignup = await signUp(owner, "plan-owner", "plan-owner@example.com", "Plan owner");
    const memberSignup = await signUp(member, "plan-member", "plan-member@example.com", "Plan member");
    const team = (await send(owner, { id: "plan-team", type: "teams.list", sessionToken: ownerSignup.data.sessionToken })).data.teams[0];
    const holder = await send(owner, { id: "plan-holder", type: "mutation.run", mutation: "setBillingHolder", args: [team.id, ownerSignup.data.auth.userId], sessionToken: ownerSignup.data.sessionToken });
    assert.equal(holder.error, null, JSON.stringify(holder.error));
    const now = new Date().toISOString();
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)",
    ).run(team.id, memberSignup.data.auth.userId, now);
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_team_plan', ?, ?)",
    ).run(team.id, now, now);
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES (?, ?, 'sandbox', 'sub_team_plan', 'price_test_studio', 'si_team_plan', 'studio', 1, 'active', 0, ?, ?, 0)",
    ).run("12121212-1212-4121-8121-121212121212", team.id, now, now);

    const input = { teamId: team.id, requestId: "13131313-1313-4131-8131-131313131313", productKey: "agency" };
    const started = await send(owner, { id: "plan-start", type: "teamBilling.requestPlanTransition", input, sessionToken: ownerSignup.data.sessionToken });
    assert.equal(started.data.state, "pending", JSON.stringify(started));
    assert.doesNotMatch(JSON.stringify(started), /price_test|cus_team|sub_team|si_team|idempotency|intent/i);
    const operation = await runtime.database.adapter.prepare(
      "SELECT [actorUserId] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
    ).get(team.id, input.requestId);
    const reconstructed = await runtime.database.readTeamBillingActorAuth(runtime.database.adapter, operation.actorUserId);
    assert.equal(reconstructed.userId, ownerSignup.data.auth.userId);
    assert.deepEqual(await runtime.database.adapter.withTransaction((transaction) => runtime.database.runTeamBillingAuthority(transaction, reconstructed, {
      operation: "plan-transition", teamId: team.id, teamRole: "admin", productKey: "agency",
    })), { allow: true });
    assert.deepEqual(billingPolicyChecks.at(-1).memberCount, { totalCount: 2 });
    await assert.rejects(() => capturedBillingPolicyCountMembers(team.id), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    const awaiting = await waitForTeamPlanOperation(runtime.database, team.id, input.requestId, "awaiting-observation");
    assert.equal(providerInputs.length, 1);
    assert.deepEqual(providerInputs[0], {
      mode: "sandbox", customerId: "cus_team_plan", subscriptionId: "sub_team_plan", subscriptionItemId: "si_team_plan",
      sourcePriceId: "price_test_studio", targetPriceId: "price_test_agency", targetProductId: "prod_test_agency",
      targetQuantity: 2, prorationDate: providerInputs[0].prorationDate, idempotencyKey: providerInputs[0].idempotencyKey,
      operationKind: "plan-transition",
    });
    assert.equal(Number.isSafeInteger(providerInputs[0].prorationDate), true);
    assert.match(providerInputs[0].idempotencyKey, /^sporades-team-billing-[a-f0-9]{64}$/);
    const acknowledged = await send(owner, { id: "plan-acknowledged", type: "teamBilling.requestPlanTransition", input, sessionToken: ownerSignup.data.sessionToken });
    assert.equal(acknowledged.data.state, "pending", "a successful Stripe response is not accepted billing truth");
    assert.equal(awaiting.status, "awaiting-observation");

    const periodStart = Math.floor(Date.now() / 1_000);
    const event = verifiedManagedSubscriptionEvent({
      providerEventId: "evt_team_plan_verified", occurred: periodStart + 1, subscriptionId: "sub_team_plan", customerId: "cus_team_plan",
      itemId: "si_team_plan", priceId: "price_test_agency", productId: "prod_test_agency", quantity: 2,
      periodStart, periodEnd: periodStart + 2_592_000,
    });
    await runAtomicStripeConsequence(
      runtime.database, { signal: new AbortController().signal }, event, undefined, applyVerifiedTeamBillingObservation,
    );
    const completed = await send(owner, { id: "plan-completed", type: "teamBilling.requestPlanTransition", input, sessionToken: ownerSignup.data.sessionToken });
    assert.deepEqual(completed.data, { state: "completed", ...input });
    const billing = await send(owner, { id: "plan-billing", type: "teamBilling.get", teamId: team.id, sessionToken: ownerSignup.data.sessionToken });
    assert.deepEqual(billing.data, {
      state: "active", teamId: team.id, productKey: "agency", quantity: 2,
      renewsAt: new Date((periodStart + 2_592_000) * 1_000).toISOString(),
    });
  } finally {
    owner?.close(); member?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless Team Portal pins reviewed configuration and exposes only an authorized short-lived continuation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-headless-team-portal-"));
  const retrieved = [];
  const created = [];
  let blockNextRetrieval = false;
  let releaseRetrieval;
  let markRetrievalStarted;
  const retrievalStarted = new Promise((resolve) => { markRetrievalStarted = resolve; });
  const retrievalRelease = new Promise((resolve) => { releaseRetrieval = resolve; });
  let failNextPortalCreateOnce = false;
  let retryPortalOperationId = null;
  let malformedNextAttestation = false;
  const runtime = await startRuntime(path.join(dir, "data.db"), billingCapsule, {
    serverEnv: { STRIPE_SECRET_KEY: "sk_test_team_portal", STRIPE_WEBHOOK_SECRET: "whsec_team_portal" },
    config: { payments: { stripe: {
      enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
      publicOrigin: "https://checkout.example.test", callbackPath: "/stripe/webhook",
      apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10_000,
    } } },
    runtimeOptions: {
      createStripeCallbackEndpoint,
      createStripeTeamBillingProvider: () => ({
        async retrievePortalConfiguration(input) {
          assert.deepEqual(Object.keys(input).sort(), ["configurationId", "expectedProducts", "mode"]);
          retrieved.push(input);
          if (blockNextRetrieval) { markRetrievalStarted(); await retrievalRelease; }
          if (malformedNextAttestation) { malformedNextAttestation = false; return { ok: false }; }
          return { ok: true };
        },
        async createPortal(input) {
          created.push(input);
          if (failNextPortalCreateOnce && retryPortalOperationId === null) {
            retryPortalOperationId = retrieved.at(-1).operationId;
            const error = new Error("transient Portal response loss");
            error.retryable = true;
            throw error;
          }
          if (retryPortalOperationId === retrieved.at(-1).operationId) failNextPortalCreateOnce = false;
          const suffix = created.length;
          return { ok: true, sessionId: `bps_test_team_portal_${suffix}`, url: `https://billing.stripe.com/p/session/team_portal_token_${suffix}` };
        },
      }),
    },
  });
  let owner; let nextHolder; let outsider;
  try {
    await runtime.database.init();
    owner = await runtime.open();
    nextHolder = await runtime.open();
    outsider = await runtime.open();
    const ownerSignup = await signUp(owner, "portal-owner", "portal-owner@example.com", "Portal owner");
    const nextSignup = await signUp(nextHolder, "portal-next", "portal-next@example.com", "Portal next");
    const outsiderSignup = await signUp(outsider, "portal-outsider", "portal-outsider@example.com", "Portal outsider");
    const team = (await send(owner, { id: "portal-team", type: "teams.list", sessionToken: ownerSignup.data.sessionToken })).data.teams[0];
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)",
    ).run(team.id, nextSignup.data.auth.userId, new Date().toISOString());
    const holder = await send(owner, { id: "portal-holder", type: "mutation.run", mutation: "setBillingHolder", args: [team.id, ownerSignup.data.auth.userId], sessionToken: ownerSignup.data.sessionToken });
    assert.equal(holder.error, null, JSON.stringify(holder.error));
    const now = new Date().toISOString();
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_team_portal', ?, ?)",
    ).run(team.id, now, now);
    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES (?, ?, 'sandbox', 'sub_team_portal', 'price_test_agency', 'agency', 2, 'active', 0, ?, ?, ?)",
    ).run("44444444-4444-4444-8444-444444444444", team.id, "2099-01-01T00:00:00.000Z", now, now);

    const input = { teamId: team.id, requestId: "33333333-3333-4333-8333-333333333333" };
    const started = await send(owner, { id: "portal-start", type: "teamBilling.openPortal", input, sessionToken: ownerSignup.data.sessionToken });
    assert.equal(started.data.state, "pending", JSON.stringify(started));
    const ready = await waitForTeamPortal(owner, input, ownerSignup.data.sessionToken, "ready");
    assert.equal(ready.data.url, "https://billing.stripe.com/p/session/team_portal_token_1");
    assert.deepEqual(retrieved[0], {
      configurationId: "bpc_test_agency",
      mode: "sandbox",
      expectedProducts: [{ productId: "prod_test_agency", priceIds: ["price_test_agency", "price_test_agency_pro"] }],
    });
    assert.deepEqual(created[0], {
      customerId: "cus_team_portal", configurationId: "bpc_test_agency", returnPath: "/settings/billing",
      idempotencyKey: created[0].idempotencyKey,
    });
    assert.doesNotMatch(JSON.stringify(ready), /cus_team_portal|bpc_test|price_test|idempotency|sessionId/i);
    const repeated = await send(owner, { id: "portal-repeat", type: "teamBilling.openPortal", input, sessionToken: ownerSignup.data.sessionToken });
    assert.equal(repeated.data.state, "ready");
    assert.equal(created.length, 1);
    const denied = await send(outsider, { id: "portal-cross-team", type: "teamBilling.openPortal", input, sessionToken: outsiderSignup.data.sessionToken });
    assert.equal(denied.error.code, "TEAM_BILLING_DENIED");
    const transfer = await send(owner, { id: "portal-transfer", type: "mutation.run", mutation: "setBillingHolder", args: [team.id, nextSignup.data.auth.userId], sessionToken: ownerSignup.data.sessionToken });
    assert.equal(transfer.error, null);
    const former = await send(owner, { id: "portal-former", type: "teamBilling.openPortal", input, sessionToken: ownerSignup.data.sessionToken });
    assert.equal(former.error.code, "TEAM_BILLING_DENIED");
    const current = await send(nextHolder, { id: "portal-current", type: "teamBilling.openPortal", input, sessionToken: nextSignup.data.sessionToken });
    assert.equal(current.data.state, "ready");
    await runtime.database.adapter.prepare("UPDATE [sporades_team_billing_customers] SET [providerCustomerId] = 'cus_team_portal_reassigned' WHERE [teamId] = ?").run(team.id);
    const reassigned = await send(nextHolder, { id: "portal-reassigned-customer", type: "teamBilling.openPortal", input, sessionToken: nextSignup.data.sessionToken });
    assert.equal(reassigned.data.state, "superseded", "ready exposure re-resolves the exact current Customer association");
    await runtime.database.adapter.prepare("UPDATE [sporades_team_billing_customers] SET [providerCustomerId] = 'cus_team_portal' WHERE [teamId] = ?").run(team.id);

    await runtime.database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES (?, ?, 'sandbox', 'sub_team_portal_ambiguous', 'price_test_agency', 'agency', 2, 'active', 0, ?, ?, ?)",
    ).run("77777777-7777-4777-8777-777777777777", team.id, "2099-01-01T00:00:00.000Z", new Date().toISOString(), new Date().toISOString());
    const ambiguousInput = { teamId: team.id, requestId: "77777777-7777-4777-8777-777777777776" };
    const ambiguous = await send(nextHolder, { id: "portal-ambiguous", type: "teamBilling.openPortal", input: ambiguousInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(ambiguous.error.code, "TEAM_BILLING_CHECKOUT_UNAVAILABLE", "multiple live licensed subscriptions fail closed before Portal admission");
    await runtime.database.adapter.prepare("DELETE FROM [sporades_team_billing_subscriptions] WHERE [id] = ?").run("77777777-7777-4777-8777-777777777777");

    const expiryInput = { teamId: team.id, requestId: "88888888-8888-4888-8888-888888888887" };
    const expiryStarted = await send(nextHolder, { id: "portal-expiry-start", type: "teamBilling.openPortal", input: expiryInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(expiryStarted.data.state, "pending");
    await waitForTeamPortal(nextHolder, expiryInput, nextSignup.data.sessionToken, "ready");
    const portalOperation = await runtime.database.adapter.prepare(
      "SELECT [id] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
    ).get(team.id, expiryInput.requestId);
    await runtime.database.adapter.prepare("UPDATE [sporades_team_billing_operations] SET [continuationExpiresAt] = '2000-01-01T00:00:00.000Z' WHERE [id] = ?").run(portalOperation.id);
    await expireTeamBillingPortal(runtime.database, {}, { operationId: portalOperation.id });
    const expired = await send(nextHolder, { id: "portal-expired", type: "teamBilling.openPortal", input: expiryInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(expired.data.state, "expired");

    failNextPortalCreateOnce = true;
    const retryInput = { teamId: team.id, requestId: "66666666-6666-4666-8666-666666666665" };
    const retryStarted = await send(nextHolder, { id: "portal-retry-start", type: "teamBilling.openPortal", input: retryInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(retryStarted.data.state, "pending");
    const retryReady = await waitForTeamPortal(nextHolder, retryInput, nextSignup.data.sessionToken, "ready", 4_000);
    assert.equal(retryReady.data.state, "ready");
    assert.deepEqual(created.slice(-2)[0], created.slice(-2)[1], "a lost Portal response retries byte-equivalent creation authority and idempotency");
    const retryOperation = await runtime.database.adapter.prepare(
      "SELECT [id] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
    ).get(team.id, retryInput.requestId);
    const retryJob = await runtime.database.adapter.prepare(
      "SELECT [id] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-portal' AND [payload] = ?",
    ).get(JSON.stringify({ operationId: retryOperation.id }));
    await runtime.database.adapter.prepare(
      "UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = 4, [leaseExpiresAt] = ?, [claimToken] = 'portal-crashed-final-claim', [failure] = NULL, [failedAt] = NULL WHERE [id] = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), retryJob.id);
    await runtime.database.adapter.prepare("UPDATE [sporades_team_billing_operations] SET [status] = 'running' WHERE [id] = ?").run(retryOperation.id);
    await recoverExpiredJobLeases(runtime.database);
    const crashRecovered = await send(nextHolder, { id: "portal-crash-recovered", type: "teamBilling.openPortal", input: retryInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(crashRecovered.data.state, "failed", "final expired-lease recovery terminally reconciles the Portal operation");
    const cleared = await runtime.database.adapter.prepare("SELECT [continuationUrl], [continuationExpiresAt] FROM [sporades_team_billing_operations] WHERE [id] = ?").get(retryOperation.id);
    assert.deepEqual({ ...cleared }, { continuationUrl: null, continuationExpiresAt: null });

    malformedNextAttestation = true;
    const malformedInput = { teamId: team.id, requestId: "99999999-9999-4999-8999-999999999998" };
    const malformedStarted = await send(nextHolder, { id: "portal-malformed-start", type: "teamBilling.openPortal", input: malformedInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(malformedStarted.data.state, "pending");
    const malformed = await waitForTeamPortal(nextHolder, malformedInput, nextSignup.data.sessionToken, "failed");
    assert.equal(malformed.data.reason, "unavailable");

    const createdBeforeAuthorityTransfer = created.length;
    blockNextRetrieval = true;
    const transferInput = { teamId: team.id, requestId: "55555555-5555-4555-8555-555555555554" };
    const transferStarted = await send(nextHolder, { id: "portal-transfer-start", type: "teamBilling.openPortal", input: transferInput, sessionToken: nextSignup.data.sessionToken });
    assert.equal(transferStarted.data.state, "pending");
    await waitForCheckoutSignal(retrievalStarted, "Portal configuration retrieval");
    const transferBack = await send(nextHolder, { id: "portal-transfer-back", type: "mutation.run", mutation: "setBillingHolder", args: [team.id, ownerSignup.data.auth.userId], sessionToken: nextSignup.data.sessionToken });
    assert.equal(transferBack.error, null);
    releaseRetrieval();
    const authorityChanged = await waitForTeamPortal(owner, transferInput, ownerSignup.data.sessionToken, "failed", 4_000);
    assert.equal(authorityChanged.data.reason, "authority-changed");
    assert.equal(created.length, createdBeforeAuthorityTransfer, "authority is rechecked after configuration attestation and before session creation");
  } finally {
    releaseRetrieval?.();
    owner?.close(); nextHolder?.close(); outsider?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("libSQL Team Billing authority and projection use the same transaction-owned contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-libsql-"));
  await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
    const serverEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
    const database = await openDevDatabase(path.join(dir, "unused.db"), "", serverEnv, {
      name: "team-billing-libsql",
      auth: { providers: { anonymous: true, email: true } },
      services: { database: { kind: "database", engine: "libsql" } },
    }, billingCapsule, { serviceEnv: serverEnv });
    try {
      await proveTeamBillingAuthorityOnAdapter(database, "33333333-3333-4333-8333-333333333333", "libsql-billing-admin");
    } finally {
      await database.close();
    }
  });
  await rm(dir, { recursive: true, force: true });
});

test("Postgres Team Billing authority and projection use the same transaction-owned contract", {
  skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres Team Billing test.",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-postgres-"));
  await withPostgresAdapter(async () => {}, { appTableNames: ["billingHolders"] });
  const serverEnv = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const database = await openDevDatabase(path.join(dir, "unused.db"), "", serverEnv, {
    name: "team-billing-postgres",
    auth: { providers: { anonymous: true, email: true } },
    services: { database: { engine: "postgres" } },
  }, billingCapsule, { serviceEnv: serverEnv });
  try {
    await proveTeamBillingAuthorityOnAdapter(database, "44444444-4444-4444-8444-444444444444", "postgres-billing-admin", { proveConcurrentDemotion: true });
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveTeamBillingAuthorityOnAdapter(database, teamId, userId, options = {}) {
  const sql = database.adapter.dialect.sql;
  const now = new Date().toISOString();
  const auth = {
    userId,
    displayName: "Billing admin",
    email: `${userId}@example.com`,
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  await database.adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run(teamId, "Billing Team", now, userId);
  await database.adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(teamId, userId, now);
  await database.adapter.prepare(sql("INSERT INTO [billingHolders] ([id], [createdAt], [updatedAt], [teamId], [userId]) VALUES (?, ?, ?, ?, ?)")).run(`${userId}-holder`, now, now, teamId, userId);
  assert.deepEqual(await readCurrentUserTeamBilling(database, auth, teamId), { state: "inactive", teamId });
  assert.throws(() => capturedBillingPolicyTable.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
  if (options.proveConcurrentDemotion) {
    let releaseDemotion;
    let markDemotionReady;
    const demotionReady = new Promise((resolve) => { markDemotionReady = resolve; });
    const holdDemotion = new Promise((resolve) => { releaseDemotion = resolve; });
    const demotion = database.adapter.withTransaction(async (transaction) => {
      await transaction.prepare(sql("UPDATE [sporades_teams] SET [name] = [name] WHERE [id] = ?")).run(teamId);
      await transaction.prepare(sql("UPDATE [sporades_team_memberships] SET [role] = 'member' WHERE [teamId] = ? AND [userId] = ?")).run(teamId, userId);
      markDemotionReady();
      await holdDemotion;
    });
    await demotionReady;
    let billingReadSettled = false;
    const billingRead = readCurrentUserTeamBilling(database, auth, teamId).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ).finally(() => { billingReadSettled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(billingReadSettled, false, "billing admission waits behind the Team lifecycle mutation");
    } finally {
      releaseDemotion();
    }
    await demotion;
    const outcome = await billingRead;
    assert.deepEqual(outcome.value, { state: "inactive", teamId }, "a committed demotion reauthorizes the safe read as a current member");
    assert.equal(billingPolicyChecks.at(-1).input.teamRole, "member");
    return;
  }
  await database.adapter.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).run(teamId, userId);
  await assert.rejects(() => readCurrentUserTeamBilling(database, auth, teamId), (error) => error?.code === "TEAM_BILLING_DENIED");
}

async function startRuntime(databasePath, capsuleDefinition = capsule, options = {}) {
  const database = await openDevDatabase(databasePath, "", options.serverEnv ?? {}, {
    name: "teams-test",
    auth: { providers: { anonymous: true, email: true } },
    ...(options.config ?? {}),
  }, capsuleDefinition, { serviceEnv: options.serverEnv ?? {}, ...(options.runtimeOptions ?? {}) });
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("request", async (request, response) => {
    if (!await handleFileHttpRoute(database, request, response) && !await routeEndpoint(database, request, response)) {
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

async function waitForTeamCheckout(socket, input, sessionToken, state, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  do {
    const result = await send(socket, { id: `checkout-poll-${attempt++}`, type: "teamBilling.startCheckout", input, sessionToken });
    if (result.data?.state === state) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Team Checkout did not reach ${state}`);
}

async function waitForTeamPortal(socket, input, sessionToken, state, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastResult = null;
  do {
    const result = await send(socket, { id: `portal-poll-${attempt++}`, type: "teamBilling.openPortal", input, sessionToken });
    lastResult = result;
    if (result.data?.state === state) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Team Portal did not reach ${state}: ${JSON.stringify(lastResult)}`);
}

async function waitForTeamPlanOperation(database, teamId, requestId, status, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  do {
    row = await database.adapter.prepare(
      "SELECT [status], [safeFailureCode] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ? AND [kind] = 'plan-transition'",
    ).get(teamId, requestId);
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Team Plan operation did not reach ${status}: ${JSON.stringify(row)}`);
}

function verifiedManagedSubscriptionEvent(input) {
  const occurredAt = new Date(input.occurred * 1_000).toISOString();
  const object = {
    id: input.subscriptionId, object: "subscription", customer: input.customerId, livemode: false,
    status: "active", cancel_at_period_end: false, metadata: {},
    items: { object: "list", has_more: false, data: [{
      id: input.itemId, object: "subscription_item", subscription: input.subscriptionId, quantity: input.quantity,
      current_period_start: input.periodStart, current_period_end: input.periodEnd,
      price: { id: input.priceId, product: input.productId, recurring: { usage_type: "licensed" } },
    }] },
  };
  return {
    provider: "stripe", providerEventId: input.providerEventId, type: "customer.subscription.updated",
    occurredAt, livemode: false, objectId: object.id,
    raw: { id: input.providerEventId, object: "event", type: "customer.subscription.updated", livemode: false, created: input.occurred, data: { object } },
  };
}

async function waitForCheckoutSignal(signal, description, timeoutMs = 2_000) {
  let timeout;
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function verifiedCheckoutObservation(providerInput, sessionId, providerEventId, type) {
  const occurredAt = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString();
  const completed = type === "checkout.session.completed";
  return {
    provider: "stripe",
    providerEventId,
    type,
    occurredAt,
    livemode: false,
    objectId: sessionId,
    raw: {
      id: providerEventId,
      object: "event",
      type,
      livemode: false,
      created: Math.floor(Date.parse(occurredAt) / 1_000),
      data: { object: {
        id: sessionId,
        object: "checkout.session",
        mode: "subscription",
        livemode: false,
        status: completed ? "complete" : "expired",
        ...(completed ? { customer: "cus_team_checkout", subscription: `sub_${sessionId}` } : {}),
        client_reference_id: providerInput.operationId,
        metadata: { sporades_team_billing_operation: providerInput.operationId },
      } },
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

function sendWithTimeout(ws, message) {
  return Promise.race([
    send(ws, message),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out awaiting ${message.type}`)), 250)),
  ]);
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
      if (property === "withTransaction" && typeof value === "function") {
        return (fn) => value.call(target, (transaction) => fn(failPendingJobInsert(transaction)));
      }
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

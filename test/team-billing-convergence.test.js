import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openDevDatabase, runAtomicStripeConsequence } from "../dist/server-runtime-source.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";

const sourceMode = process.execArgv.includes("--experimental-strip-types");
const { applyVerifiedTeamBillingObservation } = await import(sourceMode
  ? "../src/team-billing-convergence.ts" : "../dist/team-billing-convergence.js");
const runtime = sourceMode ? null : await import("../dist/team-billing-runtime.js");
const createTeamBillingTables = runtime?.createTeamBillingTables ?? createFocusedTables;
const safeTeamBillingProjection = runtime?.safeTeamBillingProjection ?? focusedProjection;

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const periodStart = 1_787_952_000;
const periodEnd = 1_790_630_400;

test("late provider events matching an erasure identity tombstone cannot recreate entitlement", async () => {
  const fixture = await openFixture();
  try {
    fixture.database.capsuleIdentity = "late-erasure-capsule";
    fixture.database.teamBillingErasureObjectKey = (providerObjectId) =>
      runtime.teamBillingErasureObjectKey(fixture.database, providerObjectId);
    const key = fixture.database.teamBillingErasureObjectKey("sub_converge");
    fixture.adapter.prepare(
      "INSERT INTO [sporades_team_billing_erasure_object_tombstones] ([objectKey], [kind], [terminalState], [providerQuiescedAt], [createdAt]) VALUES (?, 'subscription', 'cancelled', ?, ?)",
    ).run(key, "2026-08-23T12:00:00.000Z", "2026-08-23T12:00:00.000Z");
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_erased_late", "customer.subscription.updated")), { applied: false, erased: true });
    assert.equal(fixture.getSubscription(), undefined);
    assert.equal(JSON.stringify(fixture.adapter.prepare(
      "SELECT * FROM [sporades_team_billing_erasure_object_tombstones]",
    ).get()).includes("sub_converge"), false);
  } finally { fixture.close(); }
});

test("verified Team Billing observations converge with semantic ratchets and safe quarantine", async () => {
  const fixture = await openFixture();
  try {
    const eventBefore = subscriptionEvent("evt_converge_event_before", "customer.subscription.created", {
      operationId, occurred: periodStart + 10,
    });
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, eventBefore), { applied: true });
    assert.deepEqual(await safeTeamBillingProjection(fixture.adapter, fixture.definition, teamId), {
      state: "active", teamId, productKey: "agency", quantity: 2,
      renewsAt: new Date(periodEnd * 1000).toISOString(),
    });
    const operation = fixture.getOperation();
    assert.deepEqual({ status: operation.status, providerCustomerId: operation.providerCustomerId, providerSubscriptionId: operation.providerSubscriptionId }, {
      status: "ready", providerCustomerId: "cus_converge", providerSubscriptionId: "sub_converge",
    }, "subscription metadata correlates without prematurely terminalizing Checkout");

    const checkout = checkoutEvent("evt_converge_checkout", "checkout.session.completed", periodStart + 20);
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, checkout), { applied: true });
    assert.equal((await safeTeamBillingProjection(fixture.adapter, fixture.definition, teamId)).state, "active", "Checkout completion never creates entitlement");
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, checkout), { applied: false, duplicate: true });
    const impossibleExpiry = checkoutEvent("evt_converge_checkout_expired_late", "checkout.session.expired", periodStart + 21);
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, impossibleExpiry), { applied: false });
    assert.equal(fixture.getOperation().status, "completed", "semantic Checkout terminal rank never regresses completion to expiry");

    const stalePastDue = subscriptionEvent("evt_converge_stale", "customer.subscription.updated", {
      status: "past_due", occurred: periodStart + 5,
    });
    await applyVerifiedTeamBillingObservation(fixture.database, stalePastDue);
    assert.equal(fixture.getSubscription().state, "active", "older delivery cannot regress the same period");

    const equalCancelling = subscriptionEvent("evt_converge_equal_cancel", "customer.subscription.updated", {
      cancelAtPeriodEnd: true, occurred: periodStart + 10,
    });
    await applyVerifiedTeamBillingObservation(fixture.database, equalCancelling);
    assert.equal(fixture.getSubscription().cancelAtPeriodEnd, 1, "equal-time semantic severity wins without Event-ID ordering");

    const legacyInvoice = invoiceEvent("evt_converge_legacy_invoice", periodStart + 25);
    legacyInvoice.raw.data.object.lines.data[0] = { type: "subscription", proration: false, subscription: "sub_converge",
      subscription_item: "si_converge", quantity: 2, price: { id: "price_converge" }, period: { start: periodStart, end: periodEnd } };
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, legacyInvoice), { applied: false, quarantined: true }, "legacy invoice-line layouts are not mistaken for Dahlia evidence");
    const partialInvoice = invoiceEvent("evt_converge_partial_invoice", periodStart + 26);
    partialInvoice.raw.data.object.lines.has_more = true;
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, partialInvoice), { applied: false, quarantined: true }, "a first page never proves the complete Invoice line set");
    const legacyInvoiceParent = invoiceEvent("evt_converge_legacy_parent", periodStart + 27);
    legacyInvoiceParent.raw.data.object.subscription = "sub_converge";
    delete legacyInvoiceParent.raw.data.object.parent;
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, legacyInvoiceParent), { applied: false, quarantined: true }, "legacy top-level Subscription correlation cannot replace the Dahlia Invoice parent");
    const invoiceFailure = invoiceEvent("evt_converge_invoice_failed", periodStart + 30);
    await applyVerifiedTeamBillingObservation(fixture.database, invoiceFailure);
    assert.equal(fixture.getSubscription().state, "past-due");
    const recovery = subscriptionEvent("evt_converge_recovery", "customer.subscription.updated", { occurred: periodStart + 40 });
    await applyVerifiedTeamBillingObservation(fixture.database, recovery);
    assert.equal(fixture.getSubscription().state, "active", "newer verified subscription truth recovers invoice failure");

    fixture.adapter.prepare("DELETE FROM [sporades_team_memberships] WHERE [userId] = 'member-2'").run();
    const portalSwitch = subscriptionEvent("evt_converge_portal_switch", "customer.subscription.updated", {
      operationId, occurred: periodStart + 45, priceId: "price_converge_pro", productId: "prod_converge_pro",
    });
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, portalSwitch), { applied: true },
      "an existing Subscription may switch to a compatible declared Price without old Checkout metadata or a transient Team-count drift vetoing verified truth");
    assert.equal(fixture.getSubscription().productKey, "agency-pro");

    const deleted = subscriptionEvent("evt_converge_deleted", "customer.subscription.deleted", { status: "canceled", occurred: periodStart + 50 });
    await applyVerifiedTeamBillingObservation(fixture.database, deleted);
    assert.equal(fixture.getSubscription().terminalLatch, 1);
    const resurrection = subscriptionEvent("evt_converge_resurrection", "customer.subscription.updated", { occurred: periodStart + 500 });
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, resurrection), { applied: false });
    assert.equal(fixture.getSubscription().state, "cancelled", "terminal deletion latch forbids even newer resurrection");
    assert.equal((await safeTeamBillingProjection(fixture.adapter, fixture.definition, teamId)).state, "cancelled", "ignored post-deletion evidence does not replace the terminal projection with attention-required");

    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, { type: "charge.refunded" }), { applied: false, ignored: true });
    const observations = fixture.adapter.prepare("SELECT [payloadDigest], [outcome], [safeReason] FROM [sporades_team_billing_observations]").all();
    assert.ok(observations.every((row) => /^[a-f0-9]{64}$/.test(row.payloadDigest)));
    assert.doesNotMatch(JSON.stringify(observations), /raw-secret-value|cus_converge|sub_converge/, "raw provider payload and IDs are not copied into observation outcomes");
  } finally {
    fixture.close();
  }
});

test("malformed, catalogue-conflicting, multi-item, and association-conflicting evidence quarantines once", async () => {
  const fixture = await openFixture();
  try {
    for (const event of [
      subscriptionEvent("evt_converge_unknown_price", "customer.subscription.created", { operationId, priceId: "price_unknown", productId: "prod_unknown" }),
      subscriptionEvent("evt_converge_multi_item", "customer.subscription.created", { operationId, multiItem: true }),
      subscriptionEvent("evt_converge_partial_items", "customer.subscription.created", { operationId, hasMore: true }),
      subscriptionEvent("evt_converge_metered", "customer.subscription.created", { operationId, usageType: "metered" }),
      subscriptionEvent("evt_converge_trial", "customer.subscription.created", { operationId, status: "trialing" }),
    ]) {
      assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, event), { applied: false, quarantined: true });
    }
    fixture.adapter.prepare("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_other', ?, ?)")
      .run(teamId, new Date().toISOString(), new Date().toISOString());
    const conflict = subscriptionEvent("evt_converge_association", "customer.subscription.created", { operationId });
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, conflict), { applied: false, quarantined: true });
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, conflict), { applied: false, duplicate: true });
    const rows = fixture.adapter.prepare("SELECT [providerEventId], [teamId], [outcome], [safeReason] FROM [sporades_team_billing_observations] ORDER BY [providerEventId]").all();
    assert.equal(rows.length, 6);
    assert.ok(rows.every((row) => row.teamId === teamId && row.outcome === "quarantined"));
    assert.equal(rows.find((row) => row.providerEventId === "evt_converge_unknown_price").safeReason, "catalogue-mismatch");
  } finally {
    fixture.close();
  }
});

test("multiple current licensed subscriptions and newest team quarantine fail the provider-free projection closed", async () => {
  const fixture = await openFixture();
  try {
    await applyVerifiedTeamBillingObservation(fixture.database, subscriptionEvent("evt_converge_first", "customer.subscription.created", { operationId }));
    fixture.insertOperation("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await applyVerifiedTeamBillingObservation(fixture.database, subscriptionEvent("evt_converge_second", "customer.subscription.created", {
      operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", subscriptionId: "sub_converge_second", itemId: "si_converge_second", occurred: periodStart + 20,
    }));
    const ambiguous = await safeTeamBillingProjection(fixture.adapter, fixture.definition, teamId);
    assert.deepEqual(ambiguous, { state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    assert.doesNotMatch(JSON.stringify(ambiguous), /cus_|sub_|si_|price_|prod_|evt_/);
  } finally {
    fixture.close();
  }
});

test("Privileged quarantine inspection is bounded, provider-free, and callback-scoped", { skip: sourceMode }, async () => {
  const fixture = await openFixture();
  try {
    fixture.adapter.prepare(
      "INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt], [eventType], [eventRank], [outcome], [safeReason]) " +
      "VALUES ('private-observation', NULL, 'sandbox', 'evt_private_operator', 'sub_private_operator', ?, ?, ?, 'invoice.payment_failed', 40, 'quarantined', 'provider-state-ambiguous')",
    ).run("a".repeat(64), new Date(periodStart * 1000).toISOString(), new Date(periodStart * 1000).toISOString());
    const context = { __privilegedRunActive: true, signal: new AbortController().signal };
    const api = runtime.createPrivilegedTeamBillingApi(fixture.database, () => context);
    const result = await api.listQuarantines({ limit: 1 });
    assert.deepEqual(result, { quarantines: [{
      teamId: null, associatedTeam: false, mode: "sandbox", eventType: "invoice.payment_failed",
      occurredAt: new Date(periodStart * 1000).toISOString(), reason: "provider-state-ambiguous",
    }] });
    assert.doesNotMatch(JSON.stringify(result), /evt_|sub_|price_|prod_|si_|[a-f0-9]{64}/);
    await assert.rejects(api.listQuarantines({ limit: 101 }), (error) => error?.code === "INVALID_TEAM_BILLING_INSPECTION");
    context.__privilegedRunActive = false;
    await assert.rejects(api.listQuarantines(), (error) => error?.code === "PRIVILEGED_TEAM_BILLING_ACCESS_INACTIVE");
  } finally {
    fixture.close();
  }
});

test("invoice failure requires the current catalogue and validates fully before a terminal latch ignores mutation", async () => {
  const fixture = await openFixture();
  try {
    await applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_converge_catalogue_seed", "customer.subscription.created", { operationId }));
    fixture.definition.catalogue.agency.stripe.sandbox.priceId = "price_replaced";
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database,
      invoiceEvent("evt_converge_stale_catalogue", periodStart + 20)), { applied: false, quarantined: true });
    assert.equal(fixture.getSubscription().state, "active", "historical Price correlation cannot replace the current catalogue");
    fixture.definition.catalogue.agency.stripe.sandbox.priceId = "price_converge";
    await applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_converge_terminal_seed", "customer.subscription.deleted", { status: "canceled", occurred: periodStart + 30 }));
    const malformedAfterDeletion = invoiceEvent("evt_converge_terminal_malformed", periodStart + 40);
    malformedAfterDeletion.raw.data.object.lines.has_more = true;
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database, malformedAfterDeletion), { applied: false, quarantined: true },
      "the latch suppresses only mutation after the complete supported observation is validated");
    assert.equal(fixture.getSubscription().state, "cancelled");
  } finally {
    fixture.close();
  }
});

test("a current Stripe Portal period-end cancellation uses the exact cancel_at item-period boundary", async () => {
  const fixture = await openFixture();
  try {
    await applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_converge_cancel_at_seed", "customer.subscription.created", { operationId, cancelAt: null }));
    assert.equal(fixture.getSubscription().cancelAtPeriodEnd, 0);
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_converge_cancel_at_period_end", "customer.subscription.updated", {
        cancelAtPeriodEnd: false, cancelAt: periodEnd, occurred: periodStart + 20,
      })), { applied: true });
    assert.equal(fixture.getSubscription().cancelAtPeriodEnd, 1);
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_converge_unsupported_custom_cancel_at", "customer.subscription.updated", {
        cancelAtPeriodEnd: false, cancelAt: periodEnd - 60, occurred: periodStart + 30,
      })), { applied: false, quarantined: true });
  } finally {
    fixture.close();
  }
});

test("Checkout terminal ordering and unexpected database failures are deterministic", async () => {
  const fixture = await openFixture();
  try {
    const occurred = periodStart + 20;
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database,
      checkoutEvent("evt_converge_expired_first", "checkout.session.expired", occurred)), { applied: true });
    assert.equal(fixture.getOperation().status, "expired");
    assert.deepEqual(await applyVerifiedTeamBillingObservation(fixture.database,
      checkoutEvent("evt_converge_completed_same_time", "checkout.session.completed", occurred)), { applied: true });
    assert.equal(fixture.getOperation().status, "completed", "completion deterministically outranks expiry at equal provider time");

    const originalPrepare = fixture.adapter.prepare;
    fixture.adapter.prepare = (statement) => {
      if (String(statement).includes("FROM [sporades_team_billing_observations] WHERE [providerEventId]")) {
        const error = new Error("database is locked");
        error.code = "ERR_SQLITE_ERROR";
        throw error;
      }
      return originalPrepare(statement);
    };
    await assert.rejects(applyVerifiedTeamBillingObservation(fixture.database,
      subscriptionEvent("evt_converge_transient_database", "customer.subscription.updated")), /database is locked/);
    fixture.adapter.prepare = originalPrepare;
    assert.equal(fixture.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_observations] WHERE [providerEventId] = 'evt_converge_transient_database'").get().count, 0,
      "infrastructure failure escapes for atomic rollback and Job retry instead of becoming business quarantine");
  } finally {
    fixture.close();
  }
});

test("two independent PostgreSQL runtimes serialize Team billing convergence", { skip: POSTGRES_SKIP_REASON }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-convergence-postgres-"));
  const serviceEnv = {
    STRIPE_SECRET_KEY: "sk_test_convergence_postgres",
    STRIPE_WEBHOOK_SECRET: "whsec_convergence_postgres",
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const stripeConfig = {
    enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://billing.example.test", callbackPath: "/stripe/webhook",
    apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10_000,
  };
  const capsule = { teamBilling: {
    catalogue: { agency: { quantity: { kind: "fixed", value: 1 }, stripe: {
      sandbox: { priceId: "price_converge", productId: "prod_converge" },
      live: { priceId: "price_live_converge", productId: "prod_live_converge" },
    } } }, authorize: async () => ({ allow: true }),
  } };
  const config = { name: "team-billing-convergence-postgres", payments: { stripe: stripeConfig }, services: { database: { engine: "postgres" } } };
  let first; let second; let releaseLeader;
  try {
    await withPostgresAdapter(async () => {}, { appTableNames: [] });
    first = await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule,
      { createStripeCallbackEndpoint, serviceEnv });
    second = await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule,
      { createStripeCallbackEndpoint, serviceEnv });
    await first.init();
    await second.init();
    const now = new Date().toISOString();
    await first.adapter.prepare(first.adapter.dialect.sql(
      "INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES ('convergence-admin', ?, 'Admin', NULL, NULL, 1, 0, 'test')",
    )).run(now);
    await first.adapter.prepare(first.adapter.dialect.sql(
      "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Convergence', ?, 'convergence-admin')",
    )).run(teamId, now);
    await first.adapter.prepare(first.adapter.dialect.sql(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'convergence-admin', 'admin', ?)",
    )).run(teamId, now);
    await first.adapter.prepare(first.adapter.dialect.sql(
      "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity]) " +
      "VALUES (?, ?, ?, 'convergence-admin', 'checkout', 'agency', 'ready', NULL, 'convergence-postgres-idempotency', NULL, ?, ?, 'sandbox', 1)",
    )).run(operationId, operationId, teamId, now, now);

    const parentContext = () => ({
      auth: Object.freeze({ userId: "__privileged__", displayName: "Privileged server role", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "privileged-server-role" }),
      signal: new AbortController().signal, __jobEnqueuedBy: "__privileged__",
    });
    const deleted = subscriptionEvent("evt_converge_postgres_deleted", "customer.subscription.deleted", {
      operationId, status: "canceled", quantity: 1, occurred: periodStart + 100,
    });
    const active = subscriptionEvent("evt_converge_postgres_active", "customer.subscription.updated", {
      operationId, quantity: 1, occurred: periodStart + 100,
    });
    let markLeaderEntered;
    const leaderEntered = new Promise((resolve) => { markLeaderEntered = resolve; });
    const leaderRelease = new Promise((resolve) => { releaseLeader = resolve; });
    const holdAfterApply = async (database, event) => {
      await applyVerifiedTeamBillingObservation(database, event);
      markLeaderEntered();
      await leaderRelease;
    };
    const leader = runAtomicStripeConsequence(first, parentContext(), deleted, undefined, holdAfterApply);
    await leaderEntered;
    let followerSettled = false;
    const follower = runAtomicStripeConsequence(second, parentContext(), active, undefined, applyVerifiedTeamBillingObservation)
      .finally(() => { followerSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(followerSettled, false, "the second runtime cannot observe or write through the owned fence");
    releaseLeader();
    await Promise.all([leader, follower]);
    const subscription = await second.adapter.prepare(second.adapter.dialect.sql(
      "SELECT [state], [terminalLatch] FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = 'sub_converge'",
    )).get();
    assert.deepEqual(subscription, { state: "cancelled", terminalLatch: 1 });
    assert.equal((await second.adapter.prepare(second.adapter.dialect.sql(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_observations] WHERE [providerEventId] IN (?, ?)",
    )).get(deleted.providerEventId, active.providerEventId)).count, 2);
  } finally {
    releaseLeader?.();
    await Promise.all([first?.close(), second?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

async function openFixture() {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = {
    dialect: {
      sql: (statement) => statement,
      addMissingColumn: (_adapter, tableName, columnName, type) => {
        const columns = sqlite.prepare(`PRAGMA table_info([${tableName}])`).all();
        if (!columns.some((column) => column.name === columnName)) sqlite.exec(`ALTER TABLE [${tableName}] ADD COLUMN [${columnName}] ${type}`);
      },
    },
    exec: (statement) => sqlite.exec(statement),
    prepare: (statement) => sqlite.prepare(statement),
  };
  await createTeamBillingTables(adapter);
  sqlite.exec("CREATE TABLE [sporades_team_memberships] ([teamId] TEXT NOT NULL, [userId] TEXT NOT NULL)");
  adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId]) VALUES (?, ?), (?, ?)").run(teamId, "member-1", teamId, "member-2");
  const definition = {
    catalogue: {
      agency: { quantity: { kind: "team-members" }, stripe: {
        sandbox: { priceId: "price_converge", productId: "prod_converge" },
        live: { priceId: "price_live_converge", productId: "prod_live_converge" },
      } },
      "agency-pro": { quantity: { kind: "team-members" }, stripe: {
        sandbox: { priceId: "price_converge_pro", productId: "prod_converge_pro" },
        live: { priceId: "price_live_converge_pro", productId: "prod_live_converge_pro" },
      } },
    }, authorize: async () => ({ allow: true }), checkout: {}, portal: null,
  };
  const database = { adapter, teamBillingDefinition: definition, paymentsConfig: { stripe: { livemode: false } }, clock: { now: () => new Date("2026-08-23T12:00:00.000Z") } };
  const insertOperation = (id = operationId) => adapter.prepare(
    "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity]) " +
    "VALUES (?, ?, ?, 'actor', 'checkout', 'agency', 'ready', NULL, ?, NULL, ?, ?, 'sandbox', 2)",
  ).run(id, id, teamId, `idem-${id}`, new Date().toISOString(), new Date().toISOString());
  insertOperation();
  return {
    adapter, database, definition, insertOperation,
    getOperation: () => adapter.prepare("SELECT * FROM [sporades_team_billing_operations] WHERE [id] = ?").get(operationId),
    getSubscription: () => adapter.prepare("SELECT * FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = 'sub_converge'").get(),
    close: () => sqlite.close(),
  };
}

function subscriptionEvent(providerEventId, type, options = {}) {
  const occurred = options.occurred ?? periodStart + 10;
  const object = {
    id: options.subscriptionId ?? "sub_converge", object: "subscription", customer: "cus_converge", livemode: false,
    status: options.status ?? "active", cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    metadata: options.operationId ? { sporades_team_billing_operation: options.operationId } : {},
    items: { object: "list", has_more: options.hasMore ?? false, data: [{ id: options.itemId ?? "si_converge", object: "subscription_item",
      subscription: options.subscriptionId ?? "sub_converge", quantity: options.quantity ?? 2,
      current_period_start: options.periodStart ?? periodStart, current_period_end: options.periodEnd ?? periodEnd,
      price: { id: options.priceId ?? "price_converge", product: options.productId ?? "prod_converge", recurring: { usage_type: options.usageType ?? "licensed" },
    } }] },
  };
  if (Object.hasOwn(options, "cancelAt")) object.cancel_at = options.cancelAt;
  if (options.multiItem) object.items.data.push({ ...object.items.data[0], id: "si_extra" });
  return verifiedEvent(providerEventId, type, occurred, object);
}

function checkoutEvent(providerEventId, type, occurred) {
  return verifiedEvent(providerEventId, type, occurred, {
    id: "cs_test_converge", object: "checkout.session", mode: "subscription", livemode: false,
    status: type === "checkout.session.completed" ? "complete" : "expired",
    ...(type === "checkout.session.completed" ? { customer: "cus_converge", subscription: "sub_converge" } : {}), client_reference_id: operationId,
    metadata: { sporades_team_billing_operation: operationId },
  });
}

function invoiceEvent(providerEventId, occurred) {
  return verifiedEvent(providerEventId, "invoice.payment_failed", occurred, {
    id: "in_converge", object: "invoice", customer: "cus_converge", livemode: false,
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_converge" } },
    status: "open", paid: false, attempt_count: 1, lines: { object: "list", has_more: false, data: [{
      id: "il_converge", object: "line_item", invoice: "in_converge", livemode: false, quantity: 2,
      parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: "sub_converge", subscription_item: "si_converge" } },
      pricing: { type: "price_details", price_details: { price: "price_converge", product: "prod_converge" } },
      period: { start: periodStart, end: periodEnd },
    }] },
  });
}

function verifiedEvent(providerEventId, type, created, object) {
  const occurredAt = new Date(created * 1000).toISOString();
  return { provider: "stripe", providerEventId, type, occurredAt, livemode: false, objectId: object.id,
    raw: { id: providerEventId, object: "event", type, livemode: false, created, data: { object }, private: "raw-secret-value" } };
}

function createFocusedTables(adapter) {
  adapter.exec("CREATE TABLE [sporades_team_billing_customers] ([teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)");
  adapter.exec("CREATE TABLE [sporades_team_billing_subscriptions] ([id] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, [providerPriceId] TEXT NOT NULL, [providerSubscriptionItemId] TEXT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, [cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodStart] TEXT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, [lastEventOccurredAt] TEXT NULL, [lastEventKind] TEXT NULL, [lastEventRank] INTEGER NULL, [terminalLatch] INTEGER NOT NULL DEFAULT 0)");
  adapter.exec("CREATE TABLE [sporades_team_billing_operations] ([id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, [kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, [mode] TEXT, [quantity] INTEGER, [continuationUrl] TEXT, [continuationExpiresAt] TEXT, [terminalObservedAt] TEXT, [providerCustomerId] TEXT, [providerSubscriptionId] TEXT)");
  adapter.exec("CREATE TABLE [sporades_team_billing_observations] ([id] TEXT PRIMARY KEY, [teamId] TEXT NULL, [mode] TEXT NOT NULL, [providerEventId] TEXT NOT NULL UNIQUE, [providerObjectId] TEXT NULL, [payloadDigest] TEXT NOT NULL, [observedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL, [eventType] TEXT, [eventRank] INTEGER, [outcome] TEXT, [safeReason] TEXT)");
}

async function focusedProjection(adapter, definition, selectedTeamId) {
  const rows = adapter.prepare("SELECT * FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [state] IN ('active', 'past-due')").all(selectedTeamId);
  if (rows.length > 1) return { state: "attention-required", teamId: selectedTeamId, reason: "provider-state-ambiguous" };
  const row = rows[0] ?? adapter.prepare("SELECT * FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? ORDER BY [lastEventOccurredAt] DESC LIMIT 1").get(selectedTeamId);
  if (!row) return { state: "inactive", teamId: selectedTeamId };
  const common = { teamId: selectedTeamId, productKey: row.productKey, quantity: row.quantity };
  if (row.state === "cancelled") return { state: "cancelled", ...common };
  if (row.state === "past-due") return { state: "past-due", ...common };
  return row.cancelAtPeriodEnd
    ? { state: "cancelling", ...common, endsAt: row.currentPeriodEnd }
    : { state: "active", ...common, renewsAt: row.currentPeriodEnd };
}

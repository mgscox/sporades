import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { importLegacyTeamBillingEvidence, importLegacyTeamBillingReplayGuard } from "../dist/team-billing-import.js";
import { createTeamBillingTables } from "../dist/team-billing-runtime.js";

const NOW = "2026-08-24T10:00:00.000Z";

function exactInput(suffix = "legacyExact", overrides = {}) {
  return {
    sourceKey: `client-input-chaser:subscription:${suffix}`,
    teamId: "11111111-1111-4111-8111-111111111111",
    mode: "sandbox",
    providerCustomerId: `cus_${suffix}`,
    providerSubscriptionId: `sub_${suffix}`,
    providerSubscriptionItemId: `si_${suffix}`,
    providerPriceId: `price_${suffix}`,
    productKey: "agency",
    quantity: 3,
    state: "active",
    cancelAtPeriodEnd: false,
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    providerEventId: `evt_${suffix}`,
    providerEventType: "customer.subscription.updated",
    providerEventDigest: `sha256:v1:${suffix}-evidence`,
    providerObservedAt: NOW,
    retainedUntil: "2027-09-28T10:00:00.000Z",
    ...overrides,
  };
}

function sqliteFixture() {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = {
    dialect: { sql: (value) => value },
    exec: (statement) => sqlite.exec(statement),
    prepare: (statement) => sqlite.prepare(statement),
    withTransaction: async (run) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await run(adapter);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    sqlite,
    adapter,
    close: () => sqlite.close(),
    count: (table) => Number(sqlite.prepare(`SELECT COUNT(*) AS [count] FROM [${table}]`).get().count),
  };
}

test("imports exact verified legacy billing evidence atomically and idempotently", async () => {
  const fixture = sqliteFixture();
  try {
    await createTeamBillingTables(fixture.adapter);
    const input = {
      sourceKey: "client-input-chaser:subscription:legacy-subscription",
      teamId: "11111111-1111-4111-8111-111111111111",
      mode: "sandbox",
      providerCustomerId: "cus_legacyExact",
      providerSubscriptionId: "sub_legacyExact",
      providerSubscriptionItemId: "si_legacyExact",
      providerPriceId: "price_legacyExact",
      productKey: "agency",
      quantity: 3,
      state: "active",
      cancelAtPeriodEnd: false,
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      providerEventId: "evt_legacyExact",
      providerEventType: "customer.subscription.updated",
      providerEventDigest: "sha256:v1:legacy-exact-evidence",
      providerObservedAt: NOW,
      retainedUntil: "2027-09-28T10:00:00.000Z",
    };

    assert.deepEqual(await importLegacyTeamBillingEvidence(fixture.adapter, input), { outcome: "imported" });
    assert.deepEqual(await importLegacyTeamBillingEvidence(fixture.adapter, input), { outcome: "unchanged" });
    assert.equal(fixture.count("sporades_team_billing_customers"), 1);
    assert.equal(fixture.count("sporades_team_billing_subscriptions"), 1);
    assert.equal(fixture.count("sporades_team_billing_observations"), 1);
    assert.equal(fixture.count("sporades_team_billing_replay"), 1);
  } finally {
    fixture.close();
  }
});

test("durable Subscription ordering and terminal safety fields participate in exact idempotency", async (t) => {
  for (const [field, value] of [
    ["lastEventOccurredAt", "2026-08-24T09:59:59.000Z"],
    ["lastEventKind", "created"],
    ["lastEventRank", 10],
    ["terminalLatch", 1],
  ]) await t.test(field, async () => {
    const fixture = sqliteFixture();
    try {
      const input = exactInput(`ordering${field}`);
      await importLegacyTeamBillingEvidence(fixture.adapter, input);
      fixture.sqlite.prepare(`UPDATE [sporades_team_billing_subscriptions] SET [${field}] = ?`).run(value);
      await assert.rejects(
        importLegacyTeamBillingEvidence(fixture.adapter, input),
        (error) => error?.code === "TEAM_BILLING_IMPORT_CONFLICT",
      );
    } finally { fixture.close(); }
  });
});

test("legacy Subscription event and state semantics match normal convergence", async (t) => {
  for (const [label, eventType, state, cancelAtPeriodEnd, expected] of [
    ["created active", "customer.subscription.created", "active", false, { kind: "active", rank: 20, latch: 0 }],
    ["updated cancelling", "customer.subscription.updated", "active", true, { kind: "cancelling", rank: 30, latch: 0 }],
    ["updated past due", "customer.subscription.updated", "past-due", false, { kind: "past-due", rank: 40, latch: 0 }],
    ["deleted cancelled", "customer.subscription.deleted", "cancelled", false, { kind: "cancelled", rank: 50, latch: 1 }],
  ]) await t.test(`accepts ${label}`, async () => {
    const fixture = sqliteFixture();
    try {
      const input = exactInput(`semantic${label.replaceAll(" ", "")}`, { providerEventType: eventType, state, cancelAtPeriodEnd });
      await importLegacyTeamBillingEvidence(fixture.adapter, input);
      const row = fixture.sqlite.prepare("SELECT * FROM [sporades_team_billing_subscriptions]").get();
      assert.deepEqual({ kind: row.lastEventKind, rank: row.lastEventRank, latch: row.terminalLatch }, expected);
    } finally { fixture.close(); }
  });
  for (const [label, eventType, state] of [
    ["deleted active", "customer.subscription.deleted", "active"],
    ["deleted past due", "customer.subscription.deleted", "past-due"],
    ["created cancelled", "customer.subscription.created", "cancelled"],
    ["updated cancelled", "customer.subscription.updated", "cancelled"],
  ]) await t.test(`rejects ${label}`, async () => {
    const fixture = sqliteFixture();
    try {
      await createTeamBillingTables(fixture.adapter);
      await assert.rejects(
        importLegacyTeamBillingEvidence(fixture.adapter, exactInput(`invalid${label.replaceAll(" ", "")}`, { providerEventType: eventType, state })),
        (error) => error?.code === "TEAM_BILLING_IMPORT_INVALID",
      );
      assert.equal(fixture.count("sporades_team_billing_subscriptions"), 0);
    } finally { fixture.close(); }
  });
});

test("refuses changed or ambiguous evidence without partial writes", async () => {
  const fixture = sqliteFixture();
  try {
    await createTeamBillingTables(fixture.adapter);
    const base = {
      sourceKey: "client-input-chaser:subscription:conflict",
      teamId: "22222222-2222-4222-8222-222222222222",
      mode: "sandbox",
      providerCustomerId: "cus_conflict",
      providerSubscriptionId: "sub_conflict",
      providerSubscriptionItemId: "si_conflict",
      providerPriceId: "price_conflict",
      productKey: "studio",
      quantity: 1,
      state: "active",
      cancelAtPeriodEnd: false,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      providerEventId: "evt_conflict",
      providerEventType: "customer.subscription.updated",
      providerEventDigest: "sha256:v1:conflict",
      providerObservedAt: NOW,
      retainedUntil: "2027-09-28T10:00:00.000Z",
    };
    await importLegacyTeamBillingEvidence(fixture.adapter, base);
    await assert.rejects(
      importLegacyTeamBillingEvidence(fixture.adapter, { ...base, quantity: 2 }),
      (error) => error?.code === "TEAM_BILLING_IMPORT_CONFLICT",
    );
    assert.equal(fixture.sqlite.prepare("SELECT [quantity] FROM [sporades_team_billing_subscriptions]").get().quantity, 1);
    await assert.rejects(
      importLegacyTeamBillingEvidence(fixture.adapter, { ...base, sourceKey: "ambiguous", providerSubscriptionItemId: "" }),
      (error) => error?.code === "TEAM_BILLING_IMPORT_INVALID",
    );
    assert.equal(fixture.count("sporades_team_billing_subscriptions"), 1);
  } finally {
    fixture.close();
  }
});

test("imports a provider-free legacy replay guard without inventing Team association", async () => {
  const fixture = sqliteFixture();
  try {
    await createTeamBillingTables(fixture.adapter);
    const guard = {
      providerEventId: "evt_legacyReplay",
      providerEventType: "invoice.payment_failed",
      providerEventDigest: "sha256:v1:legacy-replay-evidence",
      mode: "sandbox",
      settledAt: NOW,
      retainedUntil: "2027-09-28T10:00:00.000Z",
    };
    assert.deepEqual(await importLegacyTeamBillingReplayGuard(fixture.adapter, guard), { outcome: "imported" });
    assert.deepEqual(await importLegacyTeamBillingReplayGuard(fixture.adapter, guard), { outcome: "unchanged" });
    const observation = fixture.sqlite.prepare("SELECT * FROM [sporades_team_billing_observations]").get();
    assert.equal(observation.teamId, null);
    assert.equal(observation.providerObjectId, null);
    assert.equal(observation.outcome, "ignored");
    assert.equal(observation.safeReason, "LEGACY_REPLAY_GUARD");
    assert.equal(fixture.count("sporades_team_billing_replay"), 1);
  } finally {
    fixture.close();
  }
});

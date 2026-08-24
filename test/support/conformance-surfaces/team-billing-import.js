import assert from "node:assert/strict";

import { importLegacyTeamBillingEvidence } from "../../../dist/team-billing-import.js";

const NOW = "2026-08-24T10:00:00.000Z";

function evidence(suffix) {
  return {
    sourceKey: `conformance:${suffix}`,
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
  };
}

export const CONFORMANCE_SURFACE = {
  title: "Team Billing legacy import",
  cases: [{
    name: "durable ordering and terminal fields cannot be corrupted behind unchanged evidence",
    async run(adapter) {
      for (const [index, field, value] of [
        [1, "lastEventOccurredAt", "2026-08-24T09:59:59.000Z"],
        [2, "lastEventKind", "created"],
        [3, "lastEventRank", 10],
        [4, "terminalLatch", 1],
      ]) {
        const input = evidence(`safety${index}`);
        await importLegacyTeamBillingEvidence(adapter, input);
        await adapter.prepare(adapter.dialect.sql(`UPDATE [sporades_team_billing_subscriptions] SET [${field}] = ? WHERE [teamId] = ?`)).run(value, input.teamId);
        await assert.rejects(
          importLegacyTeamBillingEvidence(adapter, input),
          (error) => error?.code === "TEAM_BILLING_IMPORT_CONFLICT",
          `${field} corruption must conflict`,
        );
        await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_replay] WHERE [providerEventId] = ?")).run(input.providerEventId);
        await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?")).run(input.providerEventId);
        await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ?")).run(input.teamId);
        await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).run(input.teamId);
      }
    },
  }, {
    name: "event types and states share normal convergence semantics",
    async run(adapter) {
      const valid = [
        ["created", "customer.subscription.created", "active", false, "active", 20, 0],
        ["cancelling", "customer.subscription.updated", "active", true, "cancelling", 30, 0],
        ["pastdue", "customer.subscription.updated", "past-due", false, "past-due", 40, 0],
        ["deleted", "customer.subscription.deleted", "cancelled", false, "cancelled", 50, 1],
      ];
      for (const [suffix, providerEventType, state, cancelAtPeriodEnd, kind, rank, latch] of valid) {
        const input = { ...evidence(`valid${suffix}`), providerEventType, state, cancelAtPeriodEnd };
        await importLegacyTeamBillingEvidence(adapter, input);
        const row = await adapter.prepare(adapter.dialect.sql("SELECT [lastEventKind], [lastEventRank], [terminalLatch] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ?")).get(input.teamId);
        assert.deepEqual({ kind: row.lastEventKind, rank: Number(row.lastEventRank), latch: Number(row.terminalLatch) }, { kind, rank, latch });
        await clearImportedEvidence(adapter, input);
      }
      for (const [suffix, providerEventType, state] of [
        ["deletedactive", "customer.subscription.deleted", "active"],
        ["deletedpastdue", "customer.subscription.deleted", "past-due"],
        ["createdcancelled", "customer.subscription.created", "cancelled"],
        ["updatedcancelled", "customer.subscription.updated", "cancelled"],
      ]) {
        const input = { ...evidence(`invalid${suffix}`), providerEventType, state };
        await assert.rejects(importLegacyTeamBillingEvidence(adapter, input), (error) => error?.code === "TEAM_BILLING_IMPORT_INVALID");
        const row = await adapter.prepare(adapter.dialect.sql("SELECT [teamId] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ?")).get(input.teamId);
        assert.equal(row == null, true);
      }
    },
  }],
};

async function clearImportedEvidence(adapter, input) {
  await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_replay] WHERE [providerEventId] = ?")).run(input.providerEventId);
  await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?")).run(input.providerEventId);
  await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ?")).run(input.teamId);
  await adapter.prepare(adapter.dialect.sql("DELETE FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).run(input.teamId);
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { createTeamBillingTables, normalizeTeamBillingDefinition, startTeamBillingCheckout } from "../dist/team-billing-runtime.js";

test("Team Checkout is an operation-specific runtime command", () => {
  assert.equal(typeof startTeamBillingCheckout, "function");
});

test("Team Billing declaration is dormant when omitted and validates an exact two-mode catalogue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-declaration-"));
  const databasePath = path.join(dir, "data.db");
  try {
    const dormant = await openDevDatabase(databasePath, "", {}, { name: "dormant" }, { name: "dormant", schema: {} });
    assert.equal(dormant.teamBillingDefinition, null);
    assert.equal(dormant.adapter.prepare("SELECT COUNT(*) AS [count] FROM sqlite_master WHERE [type] = 'table' AND [name] LIKE 'sporades_team_billing_%'").get().count, 0);
    await dormant.close();

    const authorize = async () => ({ allow: true });
    const definition = normalizeTeamBillingDefinition({
      catalogue: {
        studio: {
          quantity: { kind: "fixed", value: 1 },
          stripe: { sandbox: { priceId: "price_test_studio" }, live: { priceId: "price_live_studio" } },
        },
        agency: {
          quantity: { kind: "team-members" },
          stripe: { sandbox: { priceId: "price_test_agency" }, live: { priceId: "price_live_agency" } },
        },
      },
      authorize,
    });
    assert.deepEqual(Object.keys(definition.catalogue), ["agency", "studio"]);
    assert.equal(definition.authorize, authorize);
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.catalogue.agency.stripe));
    const portalDefinition = normalizeTeamBillingDefinition({
      catalogue: {
        studio: { quantity: { kind: "fixed", value: 1 }, stripe: {
          sandbox: { productId: "prod_test_studio", priceId: "price_test_studio", portalConfigurationId: "bpc_test_studio" },
          live: { productId: "prod_live_studio", priceId: "price_live_studio", portalConfigurationId: "bpc_live_studio" },
        } },
        agency: { quantity: { kind: "team-members" }, stripe: {
          sandbox: { productId: "prod_test_agency", priceId: "price_test_agency", portalConfigurationId: "bpc_test_agency" },
          live: { productId: "prod_live_agency", priceId: "price_live_agency", portalConfigurationId: "bpc_live_agency" },
        } },
      },
      portal: { returnPath: "/billing" },
      authorize,
    });
    assert.deepEqual(portalDefinition.portal, { returnPath: "/billing", continuationTtlSeconds: 600 });
    const boundaryPortal = (suffixLength) => ({
      catalogue: { studio: { quantity: { kind: "fixed", value: 1 }, stripe: {
        sandbox: { productId: `prod_${"a".repeat(suffixLength)}`, priceId: "price_boundary_test", portalConfigurationId: `bpc_${"b".repeat(suffixLength)}` },
        live: { productId: `prod_${"c".repeat(suffixLength)}`, priceId: "price_boundary_live", portalConfigurationId: `bpc_${"d".repeat(suffixLength)}` },
      } } }, portal: { returnPath: "/billing" }, authorize,
    });
    assert.ok(normalizeTeamBillingDefinition(boundaryPortal(240)).portal);
    assert.throws(() => normalizeTeamBillingDefinition(boundaryPortal(241)), (error) => error?.code === "INVALID_TEAM_BILLING_DECLARATION");
    assert.throws(() => normalizeTeamBillingDefinition({
      catalogue: {
        studio: { quantity: { kind: "fixed", value: 1 }, stripe: {
          sandbox: { productId: "prod_test_studio", priceId: "price_test_studio", portalConfigurationId: "bpc_test_shared" },
          live: { productId: "prod_live_studio", priceId: "price_live_studio", portalConfigurationId: "bpc_live_studio" },
        } },
        agency: { quantity: { kind: "team-members" }, stripe: {
          sandbox: { productId: "prod_test_agency", priceId: "price_test_agency", portalConfigurationId: "bpc_test_shared" },
          live: { productId: "prod_live_agency", priceId: "price_live_agency", portalConfigurationId: "bpc_live_agency" },
        } },
      }, portal: { returnPath: "/billing" }, authorize,
    }), (error) => error?.code === "INVALID_TEAM_BILLING_DECLARATION");

    const declared = await openDevDatabase(databasePath, "", {}, { name: "declared" }, {
      name: "declared",
      schema: {},
      teamBilling: { catalogue: definition.catalogue, authorize },
    });
    assert.deepEqual(Object.keys(declared.teamBillingDefinition.catalogue), ["agency", "studio"]);
    assert.equal(declared.adapter.prepare("SELECT COUNT(*) AS [count] FROM sqlite_master WHERE [type] = 'table' AND [name] LIKE 'sporades_team_billing_%'").get().count, 10);
    await declared.close();

    for (const invalid of [
      null,
      {},
      { catalogue: {}, authorize },
      { catalogue: { Studio: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_a" }, live: { priceId: "price_b" } } } }, authorize },
      { catalogue: { studio: { quantity: { kind: "fixed", value: 0 }, stripe: { sandbox: { priceId: "price_a" }, live: { priceId: "price_b" } } } }, authorize },
      { catalogue: { studio: { quantity: { kind: "fixed", value: 1_000_000 }, stripe: { sandbox: { priceId: "price_a" }, live: { priceId: "price_b" } } } }, authorize },
      { catalogue: { studio: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_same" }, live: { priceId: "price_same" } } } }, authorize },
      { catalogue: {
        studio: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_shared" }, live: { priceId: "price_studio_live" } } },
        agency: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_agency_test" }, live: { priceId: "price_shared" } } },
      }, authorize },
      { catalogue: { studio: { quantity: { kind: "team-members" }, stripe: { sandbox: { priceId: "not-a-price" }, live: { priceId: "price_b" } } } }, authorize },
      { catalogue: { studio: { quantity: { kind: "team-members" }, stripe: { sandbox: { priceId: "price_a" }, live: { priceId: "price_b" } } } }, authorize: true },
    ]) {
      assert.throws(() => normalizeTeamBillingDefinition(invalid), (error) => error?.code === "INVALID_TEAM_BILLING_DECLARATION");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Team Billing provider correlation tables are platform-owned and created in deterministic order", async () => {
  const calls = [];
  let releaseFirst;
  const adapter = {
    dialect: { sql: (statement) => statement },
    exec(statement) {
      calls.push(statement);
      if (calls.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    },
  };
  const created = createTeamBillingTables(adapter);
  assert.equal(calls.length, 1);
  releaseFirst();
  await created;
  assert.equal(calls.length, 10);
  assert.match(calls[0], /sporades_team_billing_customers/);
  assert.match(calls[1], /sporades_team_billing_subscriptions/);
  assert.match(calls[2], /sporades_team_billing_operations/);
  assert.match(calls[3], /sporades_team_billing_observations/);
  assert.match(calls[4], /sporades_team_billing_replay/);
  assert.match(calls[5], /sporades_team_billing_desired_state/);
  assert.match(calls[6], /sporades_team_billing_provider_lanes/);
  assert.match(calls[7], /sporades_team_billing_erasure_state/);
  assert.match(calls[8], /sporades_team_billing_erasure_tombstones/);
  assert.match(calls[9], /sporades_team_billing_erasure_object_tombstones/);
});

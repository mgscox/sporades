import assert from "node:assert/strict";
import { test } from "node:test";

import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/file-ingress-audit-outbox.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);

test("the Postgres conformance reset clears retained File ingress audit work", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async (adapter) => {
    await adapter.ensureFileStorage();
    await adapter.enqueueIngressClaimAudit({ claimId: "reset-contract-audit", createdAt: "2026-09-16T00:00:00.000Z" });
    assert.equal((await adapter.readIngressMaintenanceState()).auditDeliveryRequired, true);
  });

  await withPostgresAdapter(async (adapter) => {
    await adapter.ensureFileStorage();
    assert.deepEqual(await adapter.readIngressMaintenanceState(), {
      ingressRequired: false,
      auditDeliveryRequired: false,
      earliestDeliveredAt: null,
    });
  });
});

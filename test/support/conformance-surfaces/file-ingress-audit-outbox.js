import assert from "node:assert/strict";

const EARLY = "2026-09-02T09:00:00.000Z";
const MIDDLE = "2026-09-02T10:00:00.000Z";
const LATE = "2026-09-02T11:00:00.000Z";

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (File ingress audit outbox)",
  appTableNames: [],
  async prepareStorage(adapter) {
    await adapter.ensureFileStorage();
  },
  cases: [
    {
      name: "ingress audit claims are ordered, token-fenced, recoverable, and boundedly pruned",
      async run(adapter) {
        assert.equal((await adapter.enqueueIngressClaimAudit({ claimId: "claim-b", createdAt: MIDDLE })).changes, 1);
        assert.equal((await adapter.enqueueIngressClaimAudit({ claimId: "claim-a", createdAt: EARLY })).changes, 1);
        assert.equal((await adapter.enqueueIngressClaimAudit({ claimId: "claim-c", createdAt: LATE })).changes, 1);
        assert.equal((await adapter.enqueueIngressClaimAudit({ claimId: "claim-a", createdAt: LATE })).changes, 0);
        assert.deepEqual((await adapter.selectPendingIngressClaimAudits(2)).map((row) => row.claimId), ["claim-a", "claim-b"]);

        assert.equal((await adapter.claimIngressClaimAudit("claim-a", "token-a", MIDDLE)).changes, 1);
        assert.equal((await adapter.claimIngressClaimAudit("claim-a", "token-other", MIDDLE)).changes, 0);
        assert.equal((await adapter.deliverIngressClaimAudit("claim-a", "token-other", LATE)).changes, 0);
        assert.equal((await adapter.releaseIngressClaimAudit("claim-a", "token-other", LATE)).changes, 0);
        assert.equal((await adapter.releaseIngressClaimAudit("claim-a", "token-a", LATE)).changes, 1);
        assert.deepEqual((await adapter.selectPendingIngressClaimAudits(1)).map((row) => row.claimId), ["claim-a"]);

        assert.equal((await adapter.claimIngressClaimAudit("claim-a", "token-deliver", LATE)).changes, 1);
        assert.equal((await adapter.deliverIngressClaimAudit("claim-a", "token-deliver", LATE)).changes, 1);
        assert.equal((await adapter.deliverIngressClaimAudit("claim-a", "token-deliver", LATE)).changes, 0);
        assert.deepEqual((await adapter.selectPendingIngressClaimAudits(3)).map((row) => row.claimId), ["claim-b", "claim-c"]);

        assert.equal((await adapter.claimIngressClaimAudit("claim-b", "token-b", LATE)).changes, 1);
        assert.equal((await adapter.recoverIngressClaimAudits(LATE)).changes, 1);
        assert.deepEqual((await adapter.selectPendingIngressClaimAudits(3)).map((row) => row.claimId), ["claim-b", "claim-c"]);

        assert.equal((await adapter.pruneDeliveredIngressClaimAudits(MIDDLE, 1)).changes, 0);
        assert.equal((await adapter.pruneDeliveredIngressClaimAudits(LATE, 1)).changes, 1);
        assert.equal((await adapter.pruneDeliveredIngressClaimAudits(LATE, 1)).changes, 0);
      },
    },
  ],
};

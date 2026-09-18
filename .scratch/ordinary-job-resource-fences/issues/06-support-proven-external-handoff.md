# 06 — Accept durable notification intents and expose delivery uncertainty

**What to build:** Implement M1 intent acceptance in the resource transaction, then an independent SMTP delivery worker. The original strict external-handoff fence is unnecessary under M1 and remains unsolved.

**Blocked by:** M1 approval and 02. Integration against PostgreSQL also requires 04 before 07 can pass.

**Status:** blocked — amendment-awaiting-approval

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Proposed, not approved. These criteria supersede this ticket's original scope only if M1 is explicitly approved; they do not weaken the unchanged parent today.

- [ ] Implement the exact scoped notifications.accept shape, size/address/permission validation and immutable (resource, operationId, notification id) identity. Same payload deduplicates; changed payload conflicts. Return staged only until the owning engine commit; commit receipt, writes and intent atomically.
- [ ] Prove no SMTP submission before commit and no surviving intent on rollback, in ordinary Jobs and outer mutation/endpoint transactions. Scan retained accepted intents after restart; do not depend on a volatile post-commit wakeup.
- [ ] Implement accepted -> submitting -> acknowledged/rejected/unknown with a persisted attempt token committed before I/O, one attempt per intent, no transport auto-retry, and token-conditional outcome updates. Job retry/cancel and resource revocation never erase committed acceptance.
- [ ] Expose persisted states via resources.status; after restart/30 seconds treat unresolved submitting as unknown without takeover. Allow the same attempt token to report a late definitive outcome. Unknown/rejected/submitting are not automatically resent and no resend API is shipped.
- [ ] With independent workers and a controlled receiver, prove deterministic intent acceptance races, replay after unknown DB commit, and crash before/after submitting commit. Pause a sender and show a later stale SMTP acceptance is possible and explicitly outside M1; do not label this strict-fence success.
- [ ] Prove accepted-with-lost-reply and no-acceptance twins remain unknown; DB persistence failure after final reply cannot be called rollback or trigger blind resend. SMTP acknowledgement is not delivery. Test restart retains uncertainty and receipt remains committed in every delivery outcome.
- [ ] Record that this new implementation conformance must be run when 06 is dispatched; do not rerun the historical ticket-01 experiment as part of this decision task.
- [ ] Ship types, generated behavior, bounded redacted diagnostics and docs stating possible post-revocation send, possible unsent notification after crash, and no exactly-once or unconditional at-least-once promise. Do not claim original #52 is satisfied.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

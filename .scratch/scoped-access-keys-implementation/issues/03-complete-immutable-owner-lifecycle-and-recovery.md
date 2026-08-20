# 03 — Complete immutable owner lifecycle and recovery

**What to build:** Complete the owner-controlled Access-key lifecycle so users can safely inspect, rotate, expire, revoke, and delete immutable credentials, recover from lost one-time responses, and rely on account recovery or owner removal to retire every affected key atomically.

**Blocked by:** 02 — Issue, call, and revoke one scoped Access key

**Status:** complete

- [x] The trusted current-user interface exposes exactly `list`, `issue`, `rotate`, `revoke`, and `delete` with the agreed summaries, pagination, status filtering, effective scopes, total count, defaults, limits, and structured errors.
- [x] Rotation compare-and-swaps the observed lifecycle revision, preserves key identity/owner/name/grants/expiry, atomically replaces the sole selector and digest, returns the new token once, and makes the previous token fail every admission begun after commit.
- [x] Expiry is immutable and terminal at `now >= expiresAt`; revocation is irreversible and idempotent; only revoked historical rows may be deleted; active and expired keys continue reserving their owner-unique names while revoked names may be reused.
- [x] Lost issue or rotation responses are recoverable only by listing metadata and rotating again; plaintext is never retained or replayed to make a secret-bearing operation idempotent.
- [x] Owner current/retained quotas, lifecycle revisions, name conflicts, competing issuance, competing rotation, issue-versus-owner-transition serialization, rollback, and restart behavior agree across every Database adapter.
- [x] `lastUsedAt` is monotonic, approximate, successful-admission-only telemetry, coalesced to the agreed interval, and unable to fail admitted Capsule work.
- [x] Password-reset confirmation revokes Sessions and all current Access keys in the same Auth transaction; loss of linked status and owner deletion likewise bulk-revoke with the correct cause, while ordinary password changes leave keys intact and relinking never revives them.
- [x] Owner lookups remain scoped by owner user ID plus key ID, another owner's key is indistinguishable from a missing key, and no owner response exposes selectors, digests, storage fields, token fragments, or unrelated identity data.
- [x] Issue, rotate, revoke, delete, recovery, unlink, and owner-deletion audit events use bounded stable metadata and the agreed revocation causes without generic request/response capture.
- [x] Cross-engine conformance, concurrency, restart, generated-runtime parity, and emitted-PostgreSQL quoting tests prove every lifecycle and transaction invariant.

## Completion evidence

- Implementation and repair commits: `d9c72ab`, `effce34`, `90472d8`, `79e99ae`.
- Focused owner, type, password-reset, SQLite/libSQL conformance, generated-runtime, bundle, and emitted-PostgreSQL quoting suites pass; Postgres integration remains environment-skipped when `SPORADES_POSTGRES_TEST_URL` is absent.
- Independent Standards and Spec re-reviews are clean at `79e99ae`.

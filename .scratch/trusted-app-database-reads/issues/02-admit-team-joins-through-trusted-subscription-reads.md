# 02 — Admit Team joins through trusted subscription reads

**What to build:** Let a Capsule's trusted Team Join-admission policy decide from ACL-protected app state, such as the target Team's subscription plan, before Sporades atomically inserts the invited user's membership.

**Blocked by:** 01 — Introduce transaction-bound trusted app-database reads

**Status:** done

- [x] The existing Team Join-admission policy runs through the trusted-read module after authentication, Join-link validation, intended-recipient matching, and Team lifecycle locking, but before membership insertion.
- [x] Admission receives the target Team, joining user, and exact accepted-member count while its database reads use trusted policy authority rather than the invitee's ordinary row-ACL authority.
- [x] A policy can read the target Team's subscription row even when that table's read ACL permits only existing authorised Team members.
- [x] The policy context keeps the joining user as the admission subject without representing that user as a Team member, Capsule administrator, or Privileged server-role actor.
- [x] The policy context exposes no mutation methods, general Privileged server-role entry point, mutable Team interface, raw adapter, runtime-owned table, or browser-controllable authority.
- [x] Policy reads observe app writes made earlier in the same mutation transaction, and the policy decision, Join-link consumption, membership insertion, and resulting exact count commit or roll back together.
- [x] Concurrent joins for the final permitted seat serialize so exactly one commits and every later policy evaluation observes the newly committed accepted-member count.
- [x] Returning anything other than an explicit allow decision, throwing, cancellation, missing protected policy data, or an invalid decision denies the Join with the existing generic client-safe error and leaks no subscription, Team, recipient, capability, or internal failure data.
- [x] Denial and policy failure leave the Join link usable when otherwise valid, create no membership, and persist no partial admission-side state.
- [x] Same-user idempotent Join retries do not re-run admission or create another membership, while Capsules without a Join-admission policy preserve their existing behavior.
- [x] Focused SQLite, libSQL, and PostgreSQL coverage proves member-only subscription ACL access, final-seat concurrency, same-transaction visibility, rollback, post-callback revocation, and unchanged ordinary ACL behavior.
- [x] Public server declarations, source runtime, generated runtime artifacts, canonical Team documentation, product/domain language, and focused parity tests explicitly agree that admission database reads are app-table-only, read-only, transaction-bound, and exempt from ordinary row ACLs.
- [x] A raw package inspection proves the shipped artifact contains the same admission authority, declarations, documentation, and generated-runtime behavior as the reviewed source without publishing a package.

## Verification

- Implementation reviewed at `e37058ddd052c2903e7221271174a8c8cf016b28`; both the specification and standards reviews returned no findings against `f643360...e37058d`.
- `npm run build`, `npm run typecheck`, generated-bin freshness, Team contract tests, strict public-type compilation, and diff hygiene pass.
- Focused Team, trusted-read, and adapter-seam run: 52 passed, 7 skipped, 0 failed. The skips are the environment-gated PostgreSQL cases because `SPORADES_POSTGRES_TEST_URL` is not configured; their SQLite and libSQL counterparts pass and the PostgreSQL cases remain in the committed matrix.
- The final full run completed 1,739 tests: 1,649 passed, 88 skipped, and 2 failed. Both failures reproduce unchanged at the pre-ticket `f643360` baseline: `test/runtime-clock.test.js:45` and `test/oauth-provider.test.js:172`.
- `npm pack` produced `sporades-0.8.6.tgz` (SHA-1 `7dba3a7ee4620a9de5ffa751b780c0c8a24867d5`). Raw extracted files confirm the admission purpose and trusted-read path, immutable public declaration and README contract, transaction-owned pre-commit cancellation hook, generated runtimes, and CLI bundles. The package was not published.

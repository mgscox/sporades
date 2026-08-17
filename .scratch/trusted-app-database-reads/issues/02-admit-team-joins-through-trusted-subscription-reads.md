# 02 — Admit Team joins through trusted subscription reads

**What to build:** Let a Capsule's trusted Team Join-admission policy decide from ACL-protected app state, such as the target Team's subscription plan, before Sporades atomically inserts the invited user's membership.

**Blocked by:** 01 — Introduce transaction-bound trusted app-database reads

**Status:** ready-for-agent

- [ ] The existing Team Join-admission policy runs through the trusted-read module after authentication, Join-link validation, intended-recipient matching, and Team lifecycle locking, but before membership insertion.
- [ ] Admission receives the target Team, joining user, and exact accepted-member count while its database reads use trusted policy authority rather than the invitee's ordinary row-ACL authority.
- [ ] A policy can read the target Team's subscription row even when that table's read ACL permits only existing authorised Team members.
- [ ] The policy context keeps the joining user as the admission subject without representing that user as a Team member, Capsule administrator, or Privileged server-role actor.
- [ ] The policy context exposes no mutation methods, general Privileged server-role entry point, mutable Team interface, raw adapter, runtime-owned table, or browser-controllable authority.
- [ ] Policy reads observe app writes made earlier in the same mutation transaction, and the policy decision, Join-link consumption, membership insertion, and resulting exact count commit or roll back together.
- [ ] Concurrent joins for the final permitted seat serialize so exactly one commits and every later policy evaluation observes the newly committed accepted-member count.
- [ ] Returning anything other than an explicit allow decision, throwing, cancellation, missing protected policy data, or an invalid decision denies the Join with the existing generic client-safe error and leaks no subscription, Team, recipient, capability, or internal failure data.
- [ ] Denial and policy failure leave the Join link usable when otherwise valid, create no membership, and persist no partial admission-side state.
- [ ] Same-user idempotent Join retries do not re-run admission or create another membership, while Capsules without a Join-admission policy preserve their existing behavior.
- [ ] Focused SQLite, libSQL, and PostgreSQL coverage proves member-only subscription ACL access, final-seat concurrency, same-transaction visibility, rollback, post-callback revocation, and unchanged ordinary ACL behavior.
- [ ] Public server declarations, source runtime, generated runtime artifacts, canonical Team documentation, product/domain language, and focused parity tests explicitly agree that admission database reads are app-table-only, read-only, transaction-bound, and exempt from ordinary row ACLs.
- [ ] A raw package inspection proves the shipped artifact contains the same admission authority, declarations, documentation, and generated-runtime behavior as the reviewed source without publishing a package.

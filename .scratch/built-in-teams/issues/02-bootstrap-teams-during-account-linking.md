# 02 — Bootstrap Teams during account linking

**What to build:** Ensure every newly linked email or OAuth account receives its initial singleton Team and creator-admin membership as part of the account-linking outcome, while preserving the lazy path for users created before Teams existed.

**Blocked by:** 01 — List the current user's initial singleton Team.

**Status:** done

- [ ] Successful email registration creates the initial Team and creator-admin membership in the same Auth transaction as account linking and Session rotation.
- [ ] Successful OAuth identity linking creates the initial Team and creator-admin membership in the same Auth transaction as Provider identity linking and Session rotation.
- [ ] Existing-account email sign-in and OAuth sign-in do not create duplicate initial Teams or memberships.
- [ ] Every supported account-linking provider crosses the same Team bootstrap seam rather than carrying provider-specific Team implementations.
- [ ] An Auth transaction failure leaves no linked account, Team, membership, or rotated Session from the failed attempt.
- [ ] A Team bootstrap failure rolls back the account-linking outcome rather than leaving an authenticated user without the promised initial Team.
- [ ] Anonymous Session creation and ordinary Anonymous browsing create no Team rows.
- [ ] Users linked before the feature still receive the initial Team lazily through ticket 01 behavior.
- [ ] Repeated, retried, and concurrent account-linking completions remain idempotent for Team creation.
- [ ] A newly linked browser can immediately list the committed singleton Team through the public Team interface without reconnect-specific workarounds.
- [ ] Tests cover email registration, each central OAuth linking seam, existing-account sign-in, rollback, concurrency, and generated-runtime behavior through externally observable auth and Team results.
- [ ] Non-Team auth behavior and public auth shapes remain backward compatible.

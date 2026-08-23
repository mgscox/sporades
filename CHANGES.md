# Changes

## Unreleased - 2026-08-21

Changes since v0.8.7.

### 🚀 Features

- Add durable headless Team Customer Portal sessions pinned to explicitly
  attested sandbox/live configurations, compatible Plan-switch catalogues,
  period-end cancellation, disabled quantity editing, and app-owned rendering.
- Add durable headless Team Checkout with atomic duplicate admission, trusted
  Price and Team-count derivation, bounded retries, verified terminal-event
  ordering, and short-lived validated continuation URLs while apps own all UI.
- Add dormant headless Team Billing declarations with exact sandbox/live Price
  catalogues, transaction-bound Capsule authority, private runtime correlation,
  and a provider-free client projection while leaving all rendered UI to apps.
- Add opt-in transaction-owned, cross-runtime-serialized atomic Stripe
  consequences with exact read-only `teams.countMembers(teamId)` policy access.
- Bound successful reserved Stripe Event Job payloads to 30 days with
  restart-safe, adapter-portable cleanup, safe unresolved-retention inspection,
  one shared bounded mutation budget, and digest-backed replay tombstones.
- Allow token-shaped Access-key metadata (7211528).
- Implement verified Stripe event policy delivery (7a68cbe).
- Implement signed Stripe callback admission (8721c85).
- Add access key operator controls (08161a6).
- Add durable Stripe Customer Portal sessions (8a3a604).
- Preserve access key provenance in jobs (9d1cd62).
- Add scoped access key file reads (a1033cf).
- Add browser access key management (7859ecd).
- Complete owner access key lifecycle (d9c72ab).
- Implement durable one-time Stripe Checkout (79da915).
- Add user-owned scoped access keys (2ede8b3).
- Add declarative session auth admission (a62c566).
- Preserve exact endpoint body bytes (0968c99).

### 🐛 Bug Fixes

- Defer atomic Stripe fence contention durably without exhausting provider
  delivery attempts while a valid predecessor consequence still owns the fence.
- Fix Stripe callback and Vanilla policy gaps (6b5792f).
- Bound hosted inspection diagnostics (84977d0).
- Preserve bounded host inspection failures (5ff9e59).
- Bind privileged key work to run lifetime (1c201e4).
- Close operator audit and output gaps (16669ee).
- Harden access key operator boundaries (a8a6e99).
- Reject malformed schedule provenance (04d5528).
- Bind scheduled jobs to privileged actors (f0945a8).
- Validate scheduled job actor provenance (5f984a4).
- Harden durable job provenance (5023593).
- Redact file scope denial provenance (9947213).
- Correlate access key response loss (a9ed599).
- Recover access key management failures (e3d42d1).
- Require sessions for owner security changes (79e99ae).
- Close first-key transition races (90472d8).
- Serialize access key owner transitions (effce34).
- Privatize access key runtime state (f091dd8).
- Preserve middleware access key state (8d27903).
- Isolate lifecycle audit delivery (ebc095a).
- Commit access key lifecycle audits (e6b0a6d).
- Preserve access key provenance (4f87ed6).
- Isolate access key admission (48fe0a5).
- Preserve guarded handler type safety (9496593).
- Harden declarative auth admission (1d35da1).

### 📝 Documentation

- Preserve legacy auth profiles in job provenance (549542e).
- Revalidate owner Sessions and trust Cloudflare clients (ca43887).
- Keep Stripe event idempotency stable across renames (a86758e).
- Normalize access key report metadata (95bec68).
- Fix access key endpoint examples (d3098bd).
- Publish scoped access key guide (0cf7f8e).
- Define completed ticket state (b4c4dc8).
- Normalize access key ticket evidence (491a042).
- Record access key adapter identities (14277b7).
- Correct access key proof attribution (a8eadaa).
- Record access key release completion (779256b).
- Prove and pack the built-in Stripe payment contract (655e656).
- Publish access key authority contract (b6efd20).
- Close access key operator ticket (27877d5).
- Close durable job provenance ticket (14bcd01).
- Close access key file reads ticket (7a94f2a).
- Close browser access key management ticket (42a8520).
- Extend Stripe Checkout to subscriptions (8d1c72c).
- Close access key lifecycle ticket (6f06be7).
- Close scoped access key tracer (c041fa8).
- Close auth admission ticket (75c817f).
- Build dormant blank Capsule Stripe foundation (6c0e683).
- Specify user-owned scoped access keys (8325d69).

### 🧪 Tests

- Revalidate linked Access-key owners (751ee7f).
- Bound escaped Access-key operator envelopes (099a5a1).
- Revalidate Sessions during Access-key rotation (79d3e6c).
- Make Privileged Access-key writes audit-atomic (1737023).
- Timestamp Access-key revocation after locking (3b70301).
- Preserve valid Schedule diagnostic names (a002b25).
- Close Access-key authority and issuance races (f118728).
- Recheck Access-key expiry inside rotation locks (70d4c0c).
- Enforce no-store after endpoint header merging (bf50484).
- Bind File Access-key tests to live Sessions (7e63a82).
- Require live Session authority for Access-key management (155f154).
- Revalidate Sessions during Access-key issuance (3a9288e).
- Harden Access-key operator and Hosted limits (0d5f10c).
- Make Access-key operator audits atomic (3e972ac).
- Verify acceptance container cleanup (82ac350).
- Gate raw container cleanup fallback (235ac72).
- Bind acceptance cleanup to container id (0dff342).
- Report suite failures before missing proof (27d8f62).
- Reconcile JUnit suite outcomes (a19bb41).
- Recognize required JUnit suites (1dace92).
- Tokenize junit cases once (1951edd).
- Prove admitted jobs survive key retirement (717da14).
- Harden Stripe Checkout authority boundaries (c94fc74).

### 📦 Packaging

- Separate documentation validation from full suite (3863ac1).
- Harden release acceptance cleanup (b431ab4).
- Keep release failures opaque (9041772).
- Report bounded release failure details (b869c92).
- Report release suite failures (5dea6d8).
- Reconcile release junit evidence (2f9f8fe).
- Fail closed on release evidence (6f5b0a7).
- Require access key release evidence (ddd3b47).
- Close access key release proof gaps (62cc34b).
- Prove access key release contract (c29c725).

## 0.8.5 - 2026-08-15

Changes since v0.8.1.

### 🚀 Features

- Add JSON-safe positional arguments to reactive Custom queries across the
  client transport and framework adapters (5b882f5).
- Add exact pagination and join admission (63f68a0).

### 🐛 Bug Fixes

- Resolve npm audit vulnerabilities (a6a4b51).

### 📝 Documentation

- Describe parameterized queries (287ef63).
- Plan reactive query arguments (4876db8).

## 0.8.1 - 2026-08-14

Corrects the incomplete `0.8.0` package release with the merged `main` runtime,
generated artifacts, and documentation.

### 📝 Documentation

- Require current password to change email credentials (bfba651).

### ✨ Built-in Teams

- Add runtime-owned Teams for Capsule collaboration: multi-Team memberships,
  admin lifecycle, email-bound Join links, membership application roles, and
  explicit Team decisions in table and File ACLs. Teams are built in but do
  not select a current Team or automatically partition Capsule data; Sporades
  never sends Join-link email. See the [Built-in Teams reference](https://mgscox.github.io/sporades/reference/teams).

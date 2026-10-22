# Changes

## Unreleased - 2026-10-20

Changes since v0.9.34.

### 🚀 Features

- Add server-only `ctx.ai` for OpenAI-compatible Chat Completions and Responses
  endpoints behind a provider-neutral interface, with `sporades.json` `ai`
  config, a Sealed Server env key, per-call provider overrides, fail-open result
  codes, and content-free `ai.call` metering (#276).
- Add atomic human identity termination (ADR 0057) (#273) (769df876).
- Add day-based Host backup retention (retentionDays / keep-within) (#275) (3724e2ad).
- Allow loopback Stripe API origins in Dev sessions (#270) (57a9aec3).

### 🐛 Bug Fixes

- Stop Custom endpoint `ctx.signal` starting aborted on Node 24, where the
  request's own signal aborts once its body has been read (#276).
- Fix runtime injection on secondary HTML documents (#274) (91e06995).

### 🔧 Improvements

- Bump ignore (b2e1be97).

### 📝 Documentation

- Ship a stateful Stripe Team Billing fake (#269) (bceed0bc).
- Propose a supported Team Billing test-provider boundary (ADR 0058) (#268) (e62eaf87).
- Propose atomic human identity termination in ADR 0057 (#267) (29995233).
- Forbid Compose merge keys and value-bind Host elevation in ADR 0056 (#261) (edf701a6).

## v0.9.11 - 2026-09-02

Corrects the incomplete `0.9.10` npm package, which was published from a stale
local checkout before the merged release commit was pulled. This release
contains the reviewed Human Security, Service User, and lifecycle-continuation
runtime, generated artifacts, and documentation from merged `main`.

## v0.9.10 - 2026-08-31

Changes since v0.9.9.

### 🚀 Features

- Add purpose-bound reauthentication proofs (c4ddd032).
- Preserve provider-free headless Team Billing platform mechanics while Capsule UI remains app-owned.
- Add transaction-bound human Session and Access-key retirement for administrative security transitions.
- Add first-class Service Users and service-owned Access keys for named
  automation, with atomic Session-authorized lifecycle management and exact
  actor/credential provenance.

### 📝 Documentation

- Preserve the provider-free, headless Team Billing boundary: Sporades owns
  mechanics while Capsules render subscriber-visible product experience.
- Document when to use Service Users, their authority intersection, and the
  lifecycle and operational trade-offs.
- Request Google signed reauthentication time (2fa291dc).
- Verify OAuth reauthentication freshness (7a6c989a).
- Persist and serialize email reauthentication (74ef1c50).
- Harden email reauthentication contracts (a919df94).
- Sweep expired proofs before guarded mutations (c888d70c).
- Harden reauthentication lifecycle (c8189c58).
- Bind reauthentication to active sessions (e692028f).

### 🧪 Tests

- Cover Service-User rollback, lifecycle races, restart denial, provenance,
  compatibility, and secret redaction.
- Retire proofs during Session rotation (b1e25b48).
- Harden reauthentication failure and ordering proof (8f933b91).
- Require active User for proof consumption (465bf5a4).
- Recheck OAuth authorization at callback (19c4159c).

## Unreleased - 2026-08-26

Changes since v0.9.4.

### 🐛 Bug Fixes

- Dispatch Team billing after mutation commit (62482c15).
- Stage Team billing from mutation transactions (fd649a91).

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

















# Changes

## Unreleased - 2026-10-13

Changes since v0.9.31.

### 🚀 Features

- Add `ctx.app.publicOrigin`, canonical Hosted alias selection, and origin diagnostics (#231).
- Add shared Capsule rate limits and trusted-address authentication throttles (#232).
- Export HTML-safe mail helpers and support password-reset body placeholders (#230).
- Add pinned monitoring release acceptance verifier (#229) (872f33866).
- Add admission lifecycle proof harness and human verification handoff (#221) (9e4608535).
- Add resource and API-performance alerts (#222) (0dc656b53).
- Add inventory-driven availability alerts and recoveries (#204) (803ca6060).
- Support validated Auto-Submitted on send (#220) (40d3317ec).
- Add safe monitoring maintenance and fresh restore (#213) (6542368d1).
- Add bounded telemetry outage recovery and pipeline visibility (#207) (fc04b41b3).

### 🐛 Bug Fixes

- Bump for vulns (f68221783).
- Prevent favicon 404s in new scaffolds (#219) (d44aa0970).
- Offer only supported OAuth sign-in actions (#215) (1977b8e49).
- Cache hashed public assets immutably (#186) (871540c2f).

### 📝 Documentation

- Complete admission lifecycle evidence and restore Hosted stats (#227) (ffa5eb6d5).
- Preserve Collector asset modes under systemd umask (#224) (c3a6e6e65).
- Diagnose and migrate Host monitoring connections (#212) (e9c635e6f).
- Expose bounded, redacted admission evidence (#218) (4ac66e837).
- Stabilize public-tree staging and PDF deadline tests (#217) (7753267cd).
- Apply admission before WebSocket upgrades (#214) (1897d6932).
- Stabilize Dev ClamAV framed readiness on macOS (#216) (312e55e26).
- Scope Postgres and libsql live query refreshes by table (#202) (e23007e82).
- Complete canonical non-address HTTP admission matching (#210) (bdfe6d872).
- Enforce bounded fixed-window quotas for trusted admission clients (#211) (b7bbd3f13).
- Rotate and revoke per-sender telemetry credentials (#203) (789b4862a).
- Establish trusted Hosted client-address admission (#209) (b274551d2).
- Trace outbound fetch dependency time (#199) (d243884f2).
- Enforce exact-path HTTP denial before Capsule routing (#193) (3e59f8862).
- Trace individual WebSocket operations and connection activity (#198) (4473caeac).
- Complete malformed request liveness coverage (#201) (2e8c02038).
- Automatically synchronize Host lifecycle inventory (#195) (f7b35cbbc).
- Trace durable Job attempts and queue pressure (#200) (b4042ce8d).
- Trace authentication and File operations within HTTP requests (#197) (d37a224fd).
- Trace database time within Capsule requests (#196) (9e92f0fa0).
- Publish deployer-owned read-only admission policy generations (#189) (45066b7a2).
- Support project public assets across Capsule sessions (#188) (de6806ed3).
- Verify multipart limit diagnostics over real HTTP (#185) (1b8dfd77f).

### 🧪 Tests

- Make the connection-lost screen clear and actionable (#226) (6cf8993a9).

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














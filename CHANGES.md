# Changes

## Unreleased - 2026-10-02

Changes since v0.9.30.

### 🚀 Features

- Include optional project `public/` files in Dev, Container, and Hosted releases, with stable paths, Dev rebuilding, collision checks, and XML MIME handling (#187).
- Open telemetry docs (a1ef804f).
- Enable Host-owned telemetry coverage for Hosted Capsules (7b1af535).
- Add shared remote Host telemetry relay transport (f13f233a).
- Add GC and event-loop pressure telemetry (2d40feb9).
- Add periodic Capsule process resource telemetry (372ea49c).
- Add installed CLI generation for monitoring trace stack (6c17d973).
- Add standalone authenticated trace Compose stack for telemetry (1f814483).

### 🐛 Bug Fixes

- Bound ClamAV proxy Unix socket paths (#184) (a8369517).
- Fix upload, billing, browser and Host recovery ownership (1c9c74cd).
- Retain event loop stalls across metric collection (400f8961).
- Report event loop lag beyond sampling interval (6da7bc39).
- Fix bounded HTTP telemetry shutdown flush and 4xx span status (975fc10b).
- Fix telemetry status on pre-header HTTP abort (5d3a5e73).
- Reject normalized smoke origin inputs (dc1b6bc5).
- Accept canonical smoke origin spellings (82e1a9d5).
- Use certificate hostname for trace smoke origin (7c342a9f).
- Fix monitoring UI proxy lifecycle and resource p95 abort filter (5fe52461).
- Fix monitoring stack credentials, selectors, and trace retention (8cfb29d0).

### 📝 Documentation

- Resume Hosted Capsules after Host startup through shared bootstrap (66b3cfb2).
- Monitor Host pressure and Caddy through the telemetry relay (a3cc4c6c).
- Document Hosted telemetry opt-out in Host help (d2774a66).
- Report unverified Hosted telemetry coverage separately (88f56f08).
- Serialize relay reconciliation and retain Host telemetry settings (0c3bb23a).
- Export reset-gap max when native histogram has no samples (c89fad6b).
- Preserve event-loop pressure across histogram reset gap (22f78582).
- Clarify local telemetry selection ownership (b4a52e9d).
- Preserve legacy Container bundle during Dev and Host publication (140c2d6d).
- Pin telemetry exporter policy to selected profile (66f43dc2).
- Keep local Container telemetry across Dev bundle rebuilds (b643f0e2).
- Reconcile staged telemetry CA after interrupted Container deploy (ea02a390).
- Validate and stage Container telemetry CA before replacement (1db92c8a).
- Detach runtime background logs from HTTP request identity (fe6101ff).
- Harden telemetry gateway uploads and readiness (59863d33).
- Report metric export failures through telemetry diagnostics (e7a8ac4d).
- Keep telemetry dashboards readable at sparse export intervals (398ed840).
- Correlate existing logs with HTTP trace identities (0fb9ccbd).
- Clarify shipped API metrics in telemetry roadmap (09290f93).
- Measure Capsule API traffic with portable Prometheus and Grafana stack (e96a84a5).
- Report bounded local telemetry export failures (2a279361).
- Trace local Container HTTP requests with explicit telemetry profiles (94fc09d0).
- Trace Dev HTTP requests through operator Telemetry profiles (c8f34e4e).
- Harden monitoring stack initialization and prerequisite checks (52fdd593).
- Keep trace gateway non-root after root setup (44826c0f).
- Constrain trace UI proxy and preserve literal stack credentials (ffcb64ea).

### 🧪 Tests

- Expect Host-owned telemetry input in failed start fixture (c2d2b0b9).
- Expect unverified coverage from legacy Host fixture (52c02c9c).
- Flush telemetry after failed shutdown and classify CA chain errors (24d35576).
- Clean up Dev startup when watcher setup fails (eb20c57d).
- Clean up private Dev action bundles across session lifecycle (6c651120).
- Prove Container identity after Dev rebuild in Docker acceptance (db9ea7e0).
- Journal bound telemetry CA across forced replacement (f5e8ad8f).
- Journal replacement when retiring a bound telemetry CA (d6678b9e).
- Close incomplete UI upload sockets after proxy response (505642fc).
- Account for request context in Bundle census (3a78fa47).
- Support frozen injected runtime clocks (d6c51994).
- Preserve injected runtime clock receivers (fece8d3d).
- Guard Telemetry profile names and cover Bundle module census (1e9e3e61).

### 📦 Packaging

- Sync npm lock with telemetry metrics dependencies (3e706c67).

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















# Changes

## v0.9.41 - 2026-10-24

Changes since v0.9.40.

### 🚀 Features

- Allow any script version (4a43c515).
- Add Capsule implicitMutations opt-out for the implicit table mutation surface (#304) (9692d63e).
- Add explicitly sessionless public endpoints (#308) (1b367744).
- Add atomic Capsule admission for additional Team creation (#305) (d74d7999).

### 🐛 Bug Fixes

- Prevent account-wide sign-in lockout with bounded verification (#299) (b73dc192).

### 🔧 Improvements

- Regenerate dist and bin [skip ci] (271b05d2).
- Regenerate dist and bin [skip ci] (9c3e3204).

### 📝 Documentation

- Build dist and bin on main with local CI (#314) (3f555768).
- Remove the runtime-owned ctx.env browser query (#289) (#301) (cde2b5cf).
- Reject email signup from linked identities (#300) (e6348a83).
- Make the full test suite pass in office worktrees (#309) (23d1663d).
- Expose shared rate limits during Capsule File ingress admission (#307) (2f57e950).
- Revoke all account authority atomically on a browser password change (#302) (32962832).
- Isolate public collection budgets from server error delivery (#303) (c1956ad0).

### 🧪 Tests

- Wait for exported durable Job metrics (#311) (48951c93).

## v0.9.40 - 2026-10-23

Changes since v0.9.39.

### 📝 Documentation

- Upgrade Capsule base to Node 24 LTS and normalize npm pack JSON (#288) (8f5ecc5b).

### 🧪 Tests

- Describe SQLite inspection columns without StatementSync#columns() (#287) (9b29b3d5).

## v0.9.39 - 2026-10-22

Changes since v0.9.38.

### 🚀 Features

- Add read-only sporades host db list|dump|query (#286) (c9f0d358).

## Unreleased

### 🔒 Security

- Remove the runtime-owned `ctx.env` browser query (#289). Query clients,
  including Anonymous Sessions, could subscribe to the undeclared `ctx.env`
  name and receive the entire server environment. That name now follows the
  ordinary unknown-query response and returns no environment data, while
  `ctx.env` stays available to trusted server handlers. A Capsule that declares
  its own query with that name keeps the normal declared-query contract.

### 📦 Packaging

- Upgrade the default Capsule Base image to `0.3.0-node24-alpine`, using Node
  24.22.1 LTS on Alpine 3.23 with a pinned upstream image digest. Upgrade the CLI
  and Host helper and redeploy to replace existing containers; restarting a
  release preserves its pinned image. Keep explicit image overrides unchanged.
- Normalize npm pack JSON metadata across flat and package-keyed formats in
  release verification and packaged compatibility checks, preserving artifact
  hashes and rejecting ambiguous output.

### 🚀 Features

- Let Capsules opt out of implicit table mutations (#292). Declaring
  `implicitMutations: false` bounds the mutation surface to explicitly declared
  names: every undeclared name answers the ordinary unknown-mutation refusal
  before context middleware, any fallback write, mutation hooks, or success
  effects such as the deferred query rebroadcast. Omitting the flag or passing
  `true` keeps 0.9.x behavior, where undeclared names that describe a table
  (`addNote`, `updateNoteText`) insert or update rows under their fallback
  semantics. Declared mutations, server `ctx.db`, implicit table queries and
  table ACLs keep their behavior, and a bundled declared mutation matching the
  generated scaffold `add…` body stops riding the implicit path while the
  surface is retired. Present non-boolean values are rejected at authoring and
  at Capsule startup (`INVALID_IMPLICIT_MUTATIONS`). The flag is not business
  quota enforcement; declare checks in mutations, ACL rules, or hooks.
- Add read-only `sporades host db list|dump|query` for running Hosted Capsules (#285).
  It runs the Host helper over the operator's existing SSH access and the
  generated Bundle's one-shot action seam, opens the Capsule SQLite file
  read-only and query-only without stopping the Capsule, and refuses mutating
  SQL both locally and in the runtime. `--json` output matches
  `sporades db list|dump|query --json` against a Dev session. `--subname`
  defaults to the project's Host binding. Requires `sporades host upgrade` and
  a redeploy with this CLI; no public route is added.

### 🐛 Bug Fixes

- Fix `sporades host db query` failing with "columns is not a function" on
  Hosted Capsules. The previous Base image ran Node 22.14, whose `node:sqlite` lacks
  `StatementSync#columns()` (added in 22.16). SQLite inspection queries now
  describe their columns without it, including zero-row results, so Hosted,
  Dev and MCP ops queries on Node 22.13–22.15 return the same
  `{ ok, data: { columns, rows }, error }` envelope. Requires a redeploy with
  this CLI.

## v0.9.38 - 2026-10-22

Changes since v0.9.37.

### 🐛 Bug Fixes

- Fix documentation CI by preserving published release notes (#283) (9ea3c2e5).

### 📦 Packaging

- Replace deprecated OpenTelemetry trace SDK (#284) (109fee6f).

## v0.9.37 - 2026-10-22

Changes since v0.9.36.

- Replace the deprecated OpenTelemetry trace SDK dependency with
  `@opentelemetry/sdk-trace` to remove its npm installation warning.

## v0.9.36 - 2026-10-22

Changes since v0.9.35.

### 🚀 Features

- Add opt-in Capsule MCP bridge (ADR 0059) (#279) (e277f5c1).
- Add a runtime-owned, server-only `ctx.ai` client for OpenAI-compatible endpoints (#276, #277).
  The opt-in `sporades.json` `ai` block selects Chat Completions or the Responses API
  (`store: false`), a base URL and model; the key lives in Sealed Server env under
  `keyEnv` (default `AI_API_KEY`) and an unset key leaves the client dormant without
  joining the required Server env set. `ctx.ai.chat(...)` never throws or retries and
  resolves closed `AI_*` result codes; prompt and response content is never logged.

### 🐛 Bug Fixes

- Fix ctx.ai key scoping, per-call override activation, and Node 24 endpoint signal (#281) (d73bb8af).

### 📦 Packaging

- Fail fast when npm registry calls error or hang in package script (#282) (57ed5f7d).

## v0.9.35 - 2026-10-20

Changes since v0.9.34.

### 🚀 Features

- Add atomic human identity termination (ADR 0057) (#273) (769df876).
- Add day-based Host backup retention (retentionDays / keep-within) (#275) (3724e2ad).
- Allow loopback Stripe API origins in Dev sessions (#270) (57a9aec3).

### 🐛 Bug Fixes

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



















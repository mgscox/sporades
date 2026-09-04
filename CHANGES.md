# Changes

## Unreleased - 2026-09-04

Changes since v0.9.12.

### 🚀 Features

- Log a Capsule reload in a Dev session (850f4bd3).
- Run ClamAV locally for inspected ingress (de27bf6b).
- Add fail-closed ingress inspection verdicts (f7e89058).
- Add guarded endpoint file attachments (79d6f936).

### 🐛 Bug Fixes

- Correct PDF predictor row layout (be392e99).
- Fix recovered shell compound completion (5323d910).
- Fix shell path expansion classification (1c944586).
- Fix shell sentence command classification (674998d8).
- Fix ingress inspection refresh race (95383785).
- Fix file ingress inspection retries (25e30bd1).
- Retain audit outbox pruning wake (6e7a12eb).
- Bound the reload surface so it survives the payload cap (2e1c93ca).
- Preserve PDF reference delimiters (f2fce3b7).
- Resolve PDF stream metadata structurally (7830840f).
- Await the reload log so the documented check is reliable (6d4e7b8d).
- Keep reload logging from invalidating a committed reload (5e06f4fe).
- List the ingress audit outbox in the Container fixture (aaa4b80f).
- Validate every PDF xref revision (44c6f78c).
- Allow superseded object stream members (8cfec50e).
- List the ingress audit outbox in Dev session fixtures (add85980).
- Validate PDF xref object integrity (4cd5d006).
- Bound PDF object generations (276ea50e).
- Reconcile PDF hybrid cross-references (b465690d).
- Validate PDF cross-reference entries (6222e196).
- Validate complete PDF revisions (216a1dae).
- Validate PDF revision chains (ac7aab18).
- Harden file inspection lifecycle (9921fe13).
- Timestamp inspection verdict completion (71d1e404).
- Classify complete Bash command vocabulary (b14cac45).
- Classify shell command tokens and sidecar exits (d09ea150).
- Reject executable shell prefixes and dead child waits (d9c97131).
- Derive PDF action ownership from object graph (1ace57f8).
- Classify shell and PDF action contexts (d378b6d6).
- Fix scanner health and sidecar retirement (3d450704).
- Declare mail availability on the public MailApi (55444600).
- Boot a Capsule without SMTP credentials (49e56739).
- Harden hosted inspection verification (07dff616).
- Resolve indirect PDF action semantics (33f1ea32).
- Distinguish PDF action contexts (cf047cc3).
- Manage required ClamAV sidecar (52cdeb9c).
- Reject PDF actions across parsed graph (35b0c8c7).
- Harden inspected file deployment runtime (5e4e00e3).
- Bundle ingress decoders in shipped runtimes (2484f8f3).
- Authenticate loaded ClamAV signatures (e401fcce).
- Supervise ClamAV inspection lifecycle (234f7f40).
- Bind attachments to endpoint invocation (69a76156).
- Require endpoint attachment opt-in (bd7763d1).
- Harden guarded attachment responses (9694cd36).

### 🔧 Improvements

- Reconcile ingress runtime artifacts (a98cb115).

### 📝 Documentation

- Gate Dev ClamAV updater on readiness (41ddadd5).
- Notify ClamAV after signature updates (f4fee5ba).
- Harden ClamAV lifecycle deadlines (d8e3e4a8).
- Bound ClamAV startup and cleanup lifecycles (858ae717).
- Harden file inspection runtime lifecycle (57887b62).
- Classify executable Python ingress text (1ca02065).
- Use context-free raw nesting bound (4c992258).
- Bound JavaScript structure before tokenization (9883f6a9).
- Bound recursive JavaScript grammar preflight (0720df44).
- Bound strict text parser recursion (98d6c62b).
- Parse strict text uploads before admission (c2c98599).
- Harden inspected file ingress lifecycle (eebd3d4a).
- Regenerate inspection artifacts after main integration (4fd36f5c).
- Decode ingress images before clean verdicts (6d465b7a).
- Use bounded parsers for ingress content policy (96f04e36).
- Harden ingress inspection policy boundary (3436f75d).

### 🧪 Tests

- Close Dev ClamAV readiness exit race (3eca1c2c).
- Harden Dev ClamAV readiness control (469faf0a).
- Validate Hosted inspection readiness metadata (91316706).
- Gate Hosted routes on runtime readiness (00cb0e92).
- Support bounded PDF xref predictors (7d3b7068).
- Bound PDF numeric reference lookahead (af505bef).
- Bound PDF structural preflight by inspection deadline (51c8ddd3).
- Use monotonic PDF inspection deadlines (1b275b6c).
- Enforce PDF inspection load deadline (76ff4d60).
- Load PDF inspection support lazily (8772fd9a).
- Detect runnable shell prefixes before parse errors (6decceda).
- Fail closed on unresolved tilde expansion (c31f896d).
- Fail closed at shell expansion bounds (31bf7df5).
- Harden locale and PATH shell expansions (243c8ded).
- Cover standard shell path expansions (3cafb3d1).
- Refine shell command path detection (4aba0c03).
- Gate ClamAV Container replacement on readiness (008c6c78).
- Redact normalized build path aliases (9bbdd676).
- Respect Unicode build path boundaries (60f14606).
- Bound relative build path redaction (a2b864b6).
- Aggregate runtime shutdown failures (a19453de).
- Keep ClamAV child errors supervised (f2e14da6).
- Authenticate ClamAV acceptance health probes (8825a3e4).
- Retain scanner sidecar on cleanup failure (ba623fcc).
- Close strict text quoted shell bypass (fb23a63b).

### 📦 Packaging

- Bump for vuln (89a2ce1c).
- Select Hosted readiness policy by release (5abfd072).
- Regenerate artifacts for the Dev reload log event (09b3e35c).

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



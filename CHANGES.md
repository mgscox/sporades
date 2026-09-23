# Changes

## Unreleased - 2026-09-23

Changes since v0.9.26.

### 🚀 Features

- Verify prerender parity and track renderer dependencies in Dev (392b1bf2).
- Expose deliberate prerender browser handover (daa88f83).
- Complete ordered prerender placement and diagnostics (d5aa8bbe).
- Emit one Vite prerender fragment (769f523d).

### 🐛 Bug Fixes

- Retain linked package resolution alternatives (68c63e53).
- Bound dependency polling and observe path accessors (93bca941).
- Observe custom require.resolve search paths (cdfaacff).
- Observe package self-reference export targets (0b32dd2b).
- Share substitution observation for package imports (9536e562).
- Observe resolution changes inside selected packages (9325e4e6).
- Observe alternatives to successful renderer imports (6030a36d).
- Keep declarative shadow hosts within fragment ownership (a4684e8e).
- Reject inert reserved boundaries in final HTML (7fd93332).
- Observe nearer manifestless renderer packages (fdced03b).
- Bound and normalize unknown marker diagnostics (f695fea2).
- Bound module-scope Annex B wrapper aliases (fe313576).
- Normalize CommonJS renderer default exports (20d92eb4).
- Track renderer tsconfig mappings and config inputs (51c875ed).
- Separate parameter and body environments (da3772a5).
- Reject synthetic CommonJS wrapper arguments (adbc8ba3).
- Verify final Vite fragment ownership (ce8a333e).
- Reject dynamic CommonJS with scope (9183e3c2).
- Verify dismissal restores the authored DOM (9edefe18).
- Preserve source import.meta through aliases (ea6f8a2c).
- Diagnose malformed named marker directives (30083989).
- Reject shadowed direct-eval call syntax (341c4a49).
- Preserve author ancestors and implicit wrapper ownership (bb4733a5).
- Watch successful package-resolution manifests (c8c7070d).
- Use browser HTML parsing and reject direct CJS eval (75b44468).
- Watch package-import alias manifests and targets (0ceff350).
- Observe runtime module resolution attempts (2dd1181c).
- Reject fragment document-root mutations (525fcd9c).
- Finalize HTML before output-derived Vite assets (4cb4703c).
- Detect reserved comments through HTML parsing (b0a753de).
- Retain all root CommonJS wrapper redeclarations (42f0a7a8).
- Watch missing computed package export roots (b512d596).
- Initialize CommonJS source module locations (6631c412).
- Place fragments after Vite composes deferred tags (95a5fdff).
- Track failed local imports without duplicate rebuilds (122c92d8).
- Preserve failure envelopes and diagnose empty configurations (389159b1).
- Preserve module.require and TypeScript CommonJS semantics (0483d227).
- Retain worker until private completion is consumed (6db56268).
- Recover failed renderer builds after package installation (2924c02c).
- Reject fragment-created ancestors spanning boundary ends (c2678825).
- Isolate bootstrap completion from renderer progress messages (3a21a2e4).
- Redact computed runtime dependency diagnostics (9b5c776e).
- Track attempted CommonJS renderer dependencies before evaluation (f647e116).
- Reject parser-moved fragment content before publication (688e3ca4).
- Preserve quoted doctype identifiers during placement (efd3b86f).
- Reject untrackable runtime require of ESM render dependencies (d09a8737).
- Preserve foreign-content CDATA during placement (0aa70731).
- Validate source boundaries and dismiss parsed DOM ranges (054aebb3).
- Retain CommonJS wrapper values through var declarations (d1154712).
- Protect prerender boundaries and regenerate public API docs (635070d8).
- Preserve writable require and bound dynamic imports (9fdf7bf8).
- Isolate prerender execution and writable module locations (d7e83717).
- Merge renderer diagnostic aliases (07b0d17f).
- Apply file URL alias boundaries (5c030678).
- Redact project-root file URL equality (0f6545e8).
- Map raw file URL diagnostic aliases (5eb2954d).
- Bound raw file URL redaction (413ec06d).
- Bound prerender diagnostic aliases (d290f59d).
- Redact unresolved external file URLs (6516e18a).
- Redact unresolved external renderer imports (8891bc7a).
- Preserve nested prerender diagnostic paths (5f5e3fff).
- Redact hoisted renderer runtime paths (b520367e).
- Load plain hoisted prerender modules (4d762255).
- Reject early prerender worker exit (f5aec1a1).
- Classify ambiguous renderer modules (a10445fd).
- Classify package-scoped CommonJS renderers (9c3dff53).
- Preserve renderer hashbang and directives (95b5807c).
- Preserve renderer class member names (29810c22).
- Preserve CommonJS wrapper delete semantics (14da5e3e).
- Preserve CommonJS wrapper assignments (86d06b58).
- Resolve renderer lexical bindings accurately (e249665d).
- Preserve static CommonJS renderer imports (513995da).
- Preserve nested CTS module locations (ebf0db8f).
- Treat noscript as raw prerender text (e5ed75f4).
- Preserve nested CommonJS module locations (5920306e).
- Track HTML attribute value states (aac17b2e).
- Return honest renderer transform loaders (dc0f509a).
- Tokenize less-than text safely (96fc6a42).
- Fail closed on incomplete prerender HTML (b87c34ad).
- Discover renderer tsconfig per module (930f3f64).
- Reject Windows renderer module roots (f5400ef0).
- Bound malformed prerender HTML scanning (9b25a1c7).
- Preserve renderer tsconfig authority (c6b965e0).
- Redact encoded project file URLs (0a184995).
- Preserve renderer import meta URLs (03df87e1).
- Replace only HTML prerender markers (5020a1f3).
- Bound hostile renderer message access (17fc79ed).
- Preserve HTML offsets during case folding (a6a1bbe8).
- Contain renderer-owned error details (89f91139).
- Locate prerender fallback body safely (78bf529c).
- Redact prerender runtime project paths (556df1d4).
- Execute prerender bundles without ESM cache growth (62506646).

### 🔧 Improvements

- Expose internal renderer loader mapping (be8d5303).

### 📝 Documentation

- Link canonical module reference and assert parity (fce2ad85).
- Verify package-import manifest retargeting (91bb7996).
- Complete canonical client API requirements (8690e560).
- Specify prerender in canonical configuration reference (0fee4c1e).
- Expose multipart limits and runtime bounds (#98) (ad023b9e).

### 🧪 Tests

- Cover Hosted and Container warning envelopes (0e4bd01a).
- Merge file URL alias collisions (d1a26a5e).
- Redact bare project-root file URLs (6283b5d9).
- Redact project-root file URL equality (848d96c9).
- Redact contained and mixed-case file URLs (c242cc3b).
- Preserve sibling file URL prefixes (5495bdfa).
- Bound prerender diagnostic root aliases (fbb5c3b1).
- Redact unresolved external file URLs (004832b6).
- Redact unresolved external renderer imports (b7c7dabb).
- Preserve nested prerender diagnostic context (4b42f056).
- Redact hoisted prerender runtime paths (11b1d918).
- Cover prerender namespace and worker outcomes (2936ae6e).
- Fail closed when prerender worker exits (08a703cc).
- Detect ambiguous renderer module formats (af1963c3).
- Preserve renderer hashbang and directives (2008d12c).
- Preserve non-computed renderer member names (a11d2822).
- Preserve CommonJS wrapper delete semantics (9ef87b2e).
- Preserve CommonJS wrapper write targets (1de31e18).
- Preserve renderer lexical shadowing (9452a5cb).
- Preserve static renderer requires and cache bounds (f572e4ff).
- Preserve nested CTS renderer paths (3bb7d4a8).
- Ignore prerender markers inside noscript (f7172af4).
- Preserve nested CommonJS renderer paths (d40f2302).
- Specify renderer output loader mapping (cdcd65b2).
- Tokenize prose and HTML declarations safely (0e71c4e6).
- Prove extended TSX renderer config (a4da6b3f).
- Preserve less-than text during marker scanning (3481ad1e).
- Reject unterminated prerender HTML tags (fdcc0c5f).
- Discover extended renderer tsconfig (21bc1984).
- Reject Windows renderer module paths (0f4ea77f).
- Bound malformed HTML comment recovery (644acc13).
- Preserve renderer tsconfig semantics (4d1e98a9).
- Redact encoded renderer file URLs (59c22625).
- Preserve transitive renderer import meta URL (fad9ea03).
- Ignore prerender marker text in raw HTML (4d2948d4).
- Contain hostile renderer message access (d74c1372).
- Cover Unicode-safe prerender body offsets (77d2d1c4).
- Reject renderer-owned structured errors (589ab6e9).
- Cover HTML-aware prerender fallback placement (93a48e19).
- Cover prerender runtime path redaction (5e2dadb4).
- Cover prerender execution edge cases (6667a916).
- Specify one Vite prerender fragment (69ea0c58).

### 📦 Packaging

- Include regenerated prerender declaration map (a655d0fc).
- Specialize package-scoped CommonJS helpers (de79f9ba).

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













# Capsule-owned request admission and WAF options

Status: research note for [issue #49](https://github.com/mgscox/sporades/issues/49)

Last updated: 2026-09-17

## Executive recommendation

Build the issue #49 v1 substantially as proposed, but call the product surface
**request admission** rather than claiming a complete WAF. It should be a
portable Capsule-owned control that runs before app code in Dev, Container, and
Hosted sessions, with Dev in log-only mode by default. Its v1 should own:

- ordered, first-match rules;
- exact method, exact-or-prefix path, trusted client CIDR, header
  presence/exact-value, and query-key-presence conditions;
- opaque `403` deny and address-keyed `429` rate-limit actions;
- atomic, bounded hot reload from one preserved JSON file;
- explicit admission of both ordinary HTTP requests and WebSocket upgrades;
- unshadowable Host health and connection-token control paths;
- a Hosted-only trusted-client-address contract; and
- bounded structured decision logs plus unsampled counters.

Do not make Cloudflare, Appwrite, or another provider authoritative for this
contract. Cloudflare Free is useful defence in depth, but offers only five
zone-level custom rules, one narrowly matchable rate-limit rule, the Free
Managed Ruleset rather than the broader managed/OWASP rulesets, and sampled
security events. Appwrite's comparable Firewall is Appwrite Cloud-only and
Starter projects receive two rules. Those limits are incompatible with a
per-Capsule feature and could change independently of Sporades.

Treat content-signature attack detection (SQL injection, XSS, protocol
anomalies), reputation, bot challenges, and volumetric DDoS mitigation as
separate layers. A later, optional Host-server integration with Coraza and the
OWASP Core Rule Set (CRS) is the best fit for generic exploit detection because
Sporades already routes Hosted Capsules through Caddy. It should not be in v1:
CRS needs detection-only rollout, false-positive tuning, rule updates, and
operator-visible audit data.

In short: own the small deterministic gate; integrate the large evolving threat
engines. A kitchen-sink WAF inside every Capsule would mostly be a very
elaborate way to acquire false positives.

## What issue #49 is actually solving

The issue describes a missing authority boundary: a Capsule cannot currently
declare simple request controls that are enforced before its own server code.
The proposed runtime choke point is the right architectural seam, but the
implementation must cover both request paths. Ordinary HTTP enters the server
callback; `server.on("upgrade")` in `src/server-bundle-entry.ts` is a separate
path. Exempting the main `/__sporades/ws` transport would therefore let clients
bypass a Capsule deny/rate policy simply by using the app's WebSocket surface.
Run admission before the upgrade is accepted; reserve only the Host/runtime
control paths whose availability Sporades itself requires.

This is closer to Cloudflare **custom rules** or Appwrite **Firewall rules**
than to a signature WAF:

- Cloudflare custom rules use a match expression plus an action, run in order,
  and a `Block` action stops later evaluation. Free accounts get five rules and
  no regex support ([Cloudflare custom rules](https://developers.cloudflare.com/waf/custom-rules/)).
- Appwrite Firewall matches attributes including path, method, headers, query
  parameters, and IP address, then applies the first matching rule before app
  logic ([overview](https://appwrite.io/docs/products/firewall),
  [conditions](https://appwrite.io/docs/products/firewall/conditions),
  [priority](https://appwrite.io/docs/products/firewall/priority)).
- Appwrite's deny action returns `403`; its rate-limit action returns `429` with
  `Retry-After` ([Appwrite actions](https://appwrite.io/docs/products/firewall/actions)).

The issue's omissions—no regex, body inspection, challenge, redirect, request
mutation, geolocation, or vendor reputation—are strengths for a first version.
They make matching reviewable and bounded, preserve streaming bodies, and avoid
pretending a static rule file is a managed threat-intelligence service.

## Capability comparison

| Capability | Issue #49 v1 | Cloudflare Free | Appwrite Firewall | Coraza + OWASP CRS | Recommendation |
|---|---|---|---|---|---|
| Per-Capsule policy | Yes | No; zone/account configuration | No; Appwrite Cloud project | Possible, but operationally Host/proxy policy | Build |
| Ordered first-match rules | Yes | Yes for custom rules | Yes | CRS normally uses cumulative scoring | Build |
| Method/path/header/query/IP | Bounded subset | Five custom rules; no regex | Broad condition set | Much broader inspection | Build bounded subset |
| Pre-app `403` | Yes | Yes | Yes | Yes | Build |
| Per-rule, per-client `429` | Yes | One Free rule, path/verified-bot fields only | IP or user; three strategies | Not CRS's primary job | Build address-keyed v1 |
| SQLi/XSS/protocol signatures | No | Free managed subset | Separate cloud protections | Yes | Optional Host integration later |
| Challenge/bot reputation | No | Free features with caveats | Challenge on Appwrite Cloud | CrowdSec can add challenges | Defer |
| Volumetric DDoS absorption | No | Standard unmetered protection | Appwrite Cloud only | No | External network layer |
| Full-fidelity evidence | Local bounded logs/counters | Free events sampled | Cloud traffic overview | Audit logs | Build attributable local evidence |
| Works without third-party account | Yes | No | No | Yes | Required for core contract |

## Vendor and project findings

### Cloudflare

Cloudflare is valuable as an optional outer layer, including on Free, but it is
not a substitute for Capsule-owned admission:

1. Free has the **Free Managed Ruleset**, covering high-impact, widely exploited
   vulnerabilities. It does not include the broader Cloudflare Managed Ruleset
   or Cloudflare OWASP Core Ruleset
   ([managed-rules matrix](https://developers.cloudflare.com/waf/managed-rules/)).
2. Free has **five** zone-level custom rules, no regex, and no account-level
   rulesets. Capsule subdomains on one Hosted domain share that small zone
   budget ([custom-rules matrix](https://developers.cloudflare.com/waf/custom-rules/)).
3. Free has **one** rate-limiting rule. Its match fields are limited to Path and
   Verified Bot with a 10-second counting period; method, source IP, user agent,
   query, and other fields require higher plans. Counter updates can lag and
   excess requests can reach the origin
   ([rate-limiting matrix](https://developers.cloudflare.com/waf/rate-limiting-rules/)).
4. Standard unmetered L3-L7 DDoS protection, including HTTP DDoS protection, is
   available on Free. That is edge protection, not Capsule application policy
   ([DDoS plan matrix](https://developers.cloudflare.com/ddos-protection/)).
5. Free Security Events are sampled and Free has no Security Events alerts, so
   they cannot be the authoritative audit trail
   ([WAF plan matrix](https://developers.cloudflare.com/waf/)).
6. Free Bot Fight Mode is domain-wide, cannot be scoped to endpoints or skipped
   with a custom rule, and may challenge API/mobile traffic. It should be an
   operator choice, never a Sporades default
   ([Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/),
   [Free bot plan](https://developers.cloudflare.com/bots/plans/free/)).

Cloudflare Tunnel merits a separate Host-level investigation. It can expose a
service through outbound-only origin connections and prevent direct-origin
bypass without a paid Access subscription
([Tunnel overview](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
[published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/)).
It is optional infrastructure, not a prerequisite for request admission.

### Appwrite

Appwrite is useful design evidence because its Cloud Firewall resembles issue
#49: project-scoped rules are ordered by priority, AND their conditions, stop at
the first match, and can deny, bypass, challenge, rate limit, or redirect.
Conditions include path, method, header, query, CIDR, user agent, and location;
limits offer fixed-window, sliding-window, and token-bucket strategies keyed by
IP or authenticated user
([overview](https://appwrite.io/docs/products/firewall),
[conditions](https://appwrite.io/docs/products/firewall/conditions),
[actions](https://appwrite.io/docs/products/firewall/actions)).

The constraints matter more than the checklist:

- Firewall is **Appwrite Cloud**. Starter gets two rules; Pro/Scale get fifty
  ([rules and plan limits](https://appwrite.io/docs/products/firewall/rules)).
- Premium geolocation requires an add-on, and unresolved attributes have
  policy-significant match behavior
  ([conditions](https://appwrite.io/docs/products/firewall/conditions)).
- Appwrite's limiter allows traffic if the limiter is unavailable. Sporades'
  local in-process v1 need not copy that distributed-service tradeoff
  ([rate-limit action](https://appwrite.io/docs/products/firewall/actions)).
- Self-hosted Appwrite has endpoint-specific abuse limits, not the Cloud
  Firewall. Client SDK requests are limited, while Server SDK requests with API
  keys bypass them
  ([self-hosted rate limits](https://appwrite.io/docs/advanced/self-hosting/production/rate-limits)).
- Appwrite's always-on L3/L4/L7 DDoS protection is explicitly Appwrite Cloud
  infrastructure
  ([abuse protection](https://appwrite.io/docs/advanced/security/abuse-protection)).

Sporades should borrow the understandable model, not Appwrite's cloud coupling
or expanding action catalogue.

### Coraza and OWASP Core Rule Set

Coraza is the natural later generic-WAF integration. It is a Go WAF engine that
supports ModSecurity SecLang and OWASP CRS, and the project maintains a Caddy
integration ([Coraza introduction](https://www.coraza.io/docs/tutorials/introduction/),
[coraza-caddy](https://github.com/corazawaf/coraza-caddy)). Official Coraza/CRS
images include a Caddy reverse-proxy variant
([coraza-crs-docker](https://github.com/coreruleset/coraza-crs-docker)).

CRS solves a different problem: generic exploit detection using cumulative
anomaly scoring. Its documentation says a fresh deployment does not know an
application's quirks, false positives need exclusions, higher paranoia levels
increase both coverage and false alarms, and direct edits to shipped rules are
discouraged
([anomaly scoring](https://coreruleset.org/docs/2-how-crs-works/2-1-anomaly_scoring/),
[paranoia levels](https://coreruleset.org/docs/2-how-crs-works/2-2-paranoia_levels/),
[false-positive tuning](https://coreruleset.org/docs/2-how-crs-works/2-3-false-positives-and-tuning/)).

Any Coraza/CRS support should be Host-scoped, version-pinned, first rolled out
in detection-only/high-threshold observation, supplied with durable exclusions,
and tested for body-size, latency, memory, WebSocket, upload, and false-positive
behavior. It should expose redacted rule ID, anomaly score, ruleset version,
Capsule route, and correlation evidence. It should not replace admission: CRS
itself advises using a simple deny rule for a known forbidden application path
rather than inventing an anomaly-scoring signature
([CRS plugin guidance](https://coreruleset.org/docs/4-about-plugins/4-2-writing-plugins/)).

### CrowdSec

CrowdSec adds behavior-based detection, community reputation, virtual patching,
and challenges. Its AppSec component can synchronously block requests while
out-of-band rules observe expensive patterns without delaying the request
([AppSec overview](https://docs.crowdsec.net/docs/next/appsec/intro/),
[rule model](https://doc.crowdsec.net/docs/appsec/rules_syntax/)).

It also adds a security engine, local API, policy/rule lifecycle, and
remediation integration. The official proxy list highlights Nginx, OpenResty,
Traefik, Envoy Gateway, and HAProxy rather than Caddy. Defer it until a concrete
need for cross-Capsule behavior/reputation or challenges justifies a custom
Caddy integration and another Host control plane.

## Recommended v1 contract

### Bounded rules and canonical matching

Use one plain JSON policy with schema/version, stable rule IDs, enabled state,
an ordered rule array, and AND semantics within each rule. Match only method,
segment-aware exact/prefix pathname, trusted IPv4/IPv6 CIDR, canonical header
presence/exact value, and query-key presence. Avoid substring, general
negation, and regex in v1.

Specify canonicalization, including parsed path versus raw URL, percent/dot
segments, `/admin` versus `/administrator`, duplicate header behavior, repeated
query keys, IPv4-mapped IPv6, and malformed CIDR rejection at load time.

### Deny and rate limit only

`deny` should return an empty or constant-size opaque body, `403`, and
`Cache-Control: no-store`. HTTP permits an origin to refuse without disclosing
the reason ([RFC 9110 section 15.5.4](https://www.rfc-editor.org/rfc/rfc9110.html#name-403-forbidden)).

Reuse/generalize the current bounded in-memory fixed-window implementation in
`src/access-keys-runtime.ts`; do not describe it as a token bucket. Admission
buckets should be keyed by `(stable rule ID, trusted client address)`, use
monotonic elapsed time and bounded LRU-style eviction, return `429` with
`Retry-After` and `Cache-Control: no-store`, count only requests that reach the
rule, and not charge requests denied earlier. Preserve a compatible bucket on
reload when rule ID and limiter parameters are unchanged. RFC 6585 defines
`429`, permits `Retry-After`, leaves identity/counting to the implementation,
and forbids caching `429`
([RFC 6585 section 4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)).

Document fixed-window boundary bursts. Do not promise cross-process/global
quotas; Cloudflare itself warns its distributed counters are approximate.

### Trusted client-address authority

Trust `x-sporades-client-address` only in Hosted mode and ignore public proxy
headers elsewhere. RFC 7239 says forwarded data can be maliciously modified
and recommends verified trusted proxies
([section 8.1](https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1)).

The Host route must remove any incoming internal header, derive the address
from its trusted connection/proxy configuration, and set exactly one canonical
IP. Containers must remain unreachable around Caddy. The runtime accepts the
header only for Hosted, validates it, and fails closed when an address-dependent
rule has no trusted value. If Cloudflare is upstream, the Host validates that
hop or uses an authenticated tunnel; Cloudflare supplies the visitor address in
`CF-Connecting-IP`
([visitor IP restoration](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)).

### Cover WebSocket admission; reserve only control paths

Apply the same admission decision before `websocketHub.accept()` on the
separate `upgrade` event. Treat an upgrade as its actual `GET` path/headers and
return an HTTP `403`/`429` before switching protocols. The main app WebSocket
path is Capsule traffic and must not be exempt.

Host-authenticated health and connection-token control routes remain outside
Capsule policy and must not consume its buckets. Reject policy rules that target
reserved control paths rather than silently accepting ineffective rules.

### Make the mutable policy authority honest

The current generic `deploy.files` preserve mechanism mounts files read-write
inside the Capsule. If request-admission policy simply reuses that path, app
code can rewrite the policy and widen its own ingress authority. That conflicts
with the issue's "Capsule-owned" wording if the intended owner is the deployer
rather than arbitrary runtime code.

Recommended fix: introduce a dedicated declared admission-policy file copied
into runtime state and mounted/read as **read-only** to Container and Hosted
Capsules, while a Host-owned watched copy (or explicit CLI/Host publish action)
remains the mutation authority. If live in-container edits are a requirement,
state plainly that app code owns the firewall and treat it as application
configuration, not a security boundary. Do not quietly inherit `deploy.files`
`:rw` behavior.

### Atomic reload and last-known-good state

Watch the exact file. Enforce safe regular-file/no-symlink/root, byte, nesting,
condition, and rule-count bounds; parse into a new immutable policy; then swap
the whole generation atomically. On malformed update, continue enforcing the
last-known-good generation and report degradation. On configured invalid cold
start with no known-good generation, fail startup rather than serve unprotected.
Deletion through the authorized publication mechanism removes policy; transient
unreadable/mid-write state does not. Expose active digest and reload status,
not policy contents, through inspection.

### Bounded, redacted evidence

Maintain unsampled bounded counters for evaluated, admitted, denied, and
rate-limited outcomes. Sample repetitive logs per rule, but always emit policy
load failure/recovery. Log stable rule ID, action, outcome, policy digest,
session kind, route class, and a keyed address fingerprint. Never log matched
header/query values, raw query strings, credentials, bodies, or raw addresses;
never return rule IDs or reasons to untrusted clients.

## OWASP Top 10:2025 and defensible default coverage

The current released list is [OWASP Top
10:2025](https://top10.owasp.org/2025/). It is an awareness document about
broad application-security risks, not a WAF feature checklist. OWASP explicitly
says tools cannot comprehensively detect, test, or protect against the Top 10
and discourages vendors from claiming full coverage. It recommends ASVS when a
verifiable application-security standard is needed
([Establishing a Modern Application Security
Program](https://top10.owasp.org/2025/0x03_2025-Establishing_a_Modern_Application_Security_Program/)).

The following separates issue #49's direct contribution from broader defaults
Sporades can own. “Partial” means defence in depth or a targeted [virtual
patch](https://cheatsheetseries.owasp.org/cheatsheets/Virtual_Patching_Cheat_Sheet.html),
not remediation of the category's root cause.

| OWASP Top 10:2025 category | Direct contribution from issue #49 admission | Broader Sporades default or integration | Defensible assessment |
|---|---|---|---|
| [A01 Broken Access Control](https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/) | Method/path/CIDR rules can close a known administrative route or unused method and rate limits can reduce automated force-browsing. They cannot decide user, Team, tenant, object, role, CSRF intent, or outbound SSRF authority. IP is not identity. | Runtime-owned authentication, scoped Access keys, authorization primitives, same-origin defaults, and server-side resource checks should remain the paved road. | **Limited/partial.** Useful attack-surface reduction, never an authorization system. |
| [A02 Security Misconfiguration](https://top10.owasp.org/2025/A02_2025-Security_Misconfiguration/) | Bounded validated policy, reserved control routes, exact exposure rules, and fail-closed trusted-address handling materially reduce HTTP exposure mistakes. | Keep conservative security headers, same-origin CORS, technology-header suppression, automatic TLS, loopback-only Hosted ports, least-privilege/read-only containers, and deterministic config inspection as defaults. | **Material default contribution**, but not coverage of cloud/IAM, credentials, debug code, databases, parsers, or Capsule dependencies. |
| [A03 Software Supply Chain Failures](https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures/) | No root-cause protection. A narrowly targeted rule or managed WAF signature can only be a temporary virtual patch for a known HTTP exploit. | SBOM/dependency inventory, trusted sources, lockfiles, vulnerability monitoring, review, build provenance/signing, immutable promotion, patching, and staged rollout are the actual controls. | **Not addressed by request admission.** |
| [A04 Cryptographic Failures](https://top10.owasp.org/2025/A04_2025-Cryptographic_Failures/) | None beyond rejecting traffic that violates an already-defined transport policy. | Automatic TLS and sealed credential boundaries remove common footguns, but key management/rotation, password hashing, at-rest encryption, algorithm choice, randomness, certificate validation, and data classification are separate controls. | **Not addressed by request admission.** |
| [A05 Injection](https://top10.owasp.org/2025/A05_2025-Injection/) | V1 sees neither body nor parameter values, so it does not detect SQLi, XSS, command/template injection, or unsafe deserialization. A known exploit with a stable route/method shape might be temporarily blocked. | Safe typed/parameterized APIs and contextual validation/encoding prevent specific sinks. Optional Coraza/CRS can later detect common patterns, with tuning and bypass/false-positive caveats. | **Not covered by v1; limited virtual patching only.** Do not imply that a clean WAF decision means the request is injection-safe. |
| [A06 Insecure Design](https://top10.owasp.org/2025/A06_2025-Insecure_Design/) | A quota or route restriction can implement one explicit design constraint, but admission cannot repair missing business invariants, unsafe state transitions, privilege design, tenant segregation, or trust-boundary errors. OWASP says secure design is not an add-on tool. | Paved-road bounded APIs, transactions, immutable runtime-owned values, scoped capabilities, threat modelling, abuse cases, and invariant tests help at the design boundary. | **Not addressed as a category by WAF/admission; broader platform design can reduce risk.** |
| [A07 Authentication Failures](https://top10.owasp.org/2025/A07_2025-Authentication_Failures/) | Address-keyed limits on sign-in, registration, recovery, token, and Access-key routes can slow brute force and credential stuffing. Broad IP quotas are evadable by distributed attackers and can punish NAT users or be abused for denial of service. | Runtime-owned endpoint-aware failure limiting, uniform opaque failures, secure session rotation/invalidation, MFA seams, password/breached-credential policy, audience/scope validation, and account-aware signals belong in auth itself. | **Limited/partial**, but rate limiting is a worthwhile default supplement. |
| [A08 Software or Data Integrity Failures](https://top10.owasp.org/2025/A08_2025-Software_or_Data_Integrity_Failures/) | A read-only admission-policy mount, generation digest, atomic publication, and last-known-good reload protect this one policy boundary from runtime tampering. | Signed/provenanced releases and updates, verified artifacts, trusted repositories, CI/CD integrity, safe deserialization, and protection of persisted business data are separate controls. | **Not addressed as a category.** A policy digest is not software-release provenance. |
| [A09 Security Logging and Alerting Failures](https://top10.owasp.org/2025/A09_2025-Security_Logging_and_Alerting_Failures/) | Redacted structured decisions, exact unsampled counters, bounded sampling, load/recovery events, and Capsule/rule attribution provide material admission telemetry. | Define retention, clock/correlation integrity, operator health, alert thresholds and delivery failure, incident workflows, and end-to-end alert tests. Cloudflare Free sampled events cannot be the audit source. | **Material logging contribution; partial overall.** OWASP emphasizes that logging without actionable alerting is insufficient. |
| [A10 Mishandling of Exceptional Conditions](https://top10.owasp.org/2025/A10_2025-Mishandling_of_Exceptional_Conditions/) | Bounded parsing/state, atomic reload, last-known-good enforcement, invalid-cold-start failure, trusted-address fail-closed behavior, opaque errors, deterministic limiter eviction, and rate limits make admission itself fail securely. OWASP expressly recommends validation, quotas, throttling, rollback, and failing closed. | Capsule handlers still need local validation, cleanup, cancellation/timeout handling, transactional rollback, concurrency safety, centralized opaque error handling, and recovery from downstream failure. | **Material default for the platform-owned admission boundary; partial overall.** |

### OWASP-aligned defaults to incorporate

No request-admission policy should still mean no behavior change; the issue's
byte/parity acceptance criterion is correct. The useful defaults belong at
Sporades-owned boundaries:

1. **A02:** retain secure HTTP/TLS/container defaults and add a schema-versioned,
   bounded, read-only admission-policy publication path with inspection.
2. **A07:** keep authentication and Access-key failure limits runtime-owned and
   enabled by default, using bounded per-source and, where safely known,
   per-account/selector buckets. Capsule admission remains a coarse extra quota.
3. **A09:** when a policy is configured, emit redacted security events and exact
   counters by default, expose a safe health summary, and provide an alert
   handoff rather than marketing logs alone as protection.
4. **A10:** make every Sporades-owned parser/config/request boundary bounded,
   atomic, opaque, observable, and fail closed where losing authority would
   widen access. Retain known-good policy during a bad live edit; fail a
   configured cold start that has never loaded a valid generation.
5. **A01/A06:** make runtime-owned authorization, transactions, scoped
   capabilities, file checks, and bounded APIs easier than bypassing them, while
   documenting that the Capsule must still authorize resources and workflows.

Do not advertise “OWASP Top 10 protection,” “covers 8/10,” or similar
arithmetic. A defensible claim is narrower: **Sporades supplies secure defaults
and defence-in-depth controls relevant to parts of A01, A02, A06, A07, A09, and
A10; request admission itself principally contributes coarse exposure
reduction, abuse throttling, admission telemetry, and secure failure behavior.**
A03, A04, A05, and A08 require supply-chain, cryptographic, secure-coding, and
integrity controls outside this feature.

## Build, integrate, defer

### Build now

- The bounded rule contract and both HTTP/upgrade admission seams.
- Dedicated read-only deployed policy authority, not generic `deploy.files`
  `:rw` semantics.
- Atomic reload, last-known-good state, and invalid-cold-start failure.
- Hosted address overwrite/validation at Caddy and runtime boundaries.
- Generalized bounded fixed-window limiter with `Retry-After`.
- Reserved control routes, redacted logs, counters, digest, and inspection.
- Dev log-only; Container and Hosted enforcement.

### Integrate/document as optional defence in depth

- Cloudflare Free proxying, Free Managed Ruleset, and standard DDoS protection;
  never claim the paid managed/OWASP rulesets.
- Host inspection that reports whether Cloudflare is actually proxied and
  whether origin bypass remains possible, without requiring Cloudflare.
- Cloudflare Tunnel as a later origin-isolation option.
- Coraza + CRS as opt-in Host policy after a measured detection-only pilot.

### Defer

- Regex, body/response inspection, cookies, mutation, redirect, configurable
  bypass/allow, and application signatures.
- CAPTCHA, managed bots, reputation, geo/ASN/device classification, and leaked
  credential detection.
- Per-user/session limits at the pre-auth choke point; enforce them after
  identity verification instead.
- Shared/distributed limits, adaptive scoring, and automatic bans.
- CrowdSec until supported Caddy integration and a concrete behavior-security
  requirement justify it.
- Any promise of volumetric DDoS protection from Capsule code or Host-local WAF.

## Acceptance criteria worth adding

1. Every concurrent request/upgrade observes a complete old or new generation.
2. Malformed/truncated replacement retains known-good policy and reports
   degradation; invalid cold start serves no app traffic.
3. Encoded paths, dot segments, duplicate headers, repeated query keys,
   IPv4-mapped IPv6, method casing, and prefix boundaries are specified.
4. `429` has correct `Retry-After`/no-store; fixed-window boundaries are tested
   under a fake clock.
5. Address-cardinality attacks cannot exceed bucket caps; eviction is
   deterministic and observable.
6. Compatible limiter rules preserve buckets on reload; changed rules do not
   inherit incompatible state.
7. Forged public/internal forwarded headers never acquire Hosted identity;
   Caddy overwrites rather than appends.
8. WebSocket upgrades are denied/rate-limited before `101`; health and
   connection-token control paths remain available and uncharged.
9. Runtime code cannot mutate a deployer-owned policy through its mounted path.
10. High-rate denial proves exact counters while logs remain bounded/redacted.
11. No-config parity covers response bytes, route ordering, streaming, upgrades,
    logging, latency budget, and generated Bundle parity.

## Decision

Issue #49 should proceed as a narrow, provider-independent request-admission
feature. Cloudflare Free should be recommended—not assumed—as an outer DDoS
and managed-rule layer. Appwrite is design evidence, not an integration target.
Coraza/CRS is the preferred later opt-in for generic exploit signatures, with
CrowdSec considered only when behavior/reputation features justify another Host
service. This keeps "works on Sporades" from quietly meaning "works if your
Cloudflare invoice is feeling generous."

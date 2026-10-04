# Request-admission policy is deployer-owned

Status: Accepted

## Context

Issue #66 establishes the publication and generation lifecycle for #49. Generic
`deploy.files` with `update: "preserve"` intentionally grants Capsule code write
access. Reusing that authority would let Capsule code rewrite its ingress policy.
A single-file Docker bind mount also pins an inode and hides atomic replacements.

## Decision

Declare one `admissionPolicy.path` in `sporades.json`. It is a project-relative
seed, validated with the deployment file containment and no-symlink boundary.
It cannot overlap generic deployment files. The internal release manifest uses
`update: "admission"`; that value is rejected in project `deploy.files`.

Reuse the journal-before-seed protocol, with policy copies isolated beneath
`preserved-files/admission/`. Files are host-owned, single-link regular files,
mode 0444, keyed by the SHA-256 of the normalized logical path. Their directory
is mounted read-only at `/run/sporades-admission`; neither the generic writable
file mounts nor `/app/data` expose it. A directory mount makes atomic replacements
visible. The launch environment pins the deployed declaration independently of
Dev rebuilds. Host release history selects it on restart and rollback.

The authorized local operator uses `sporades deploy policy publish <file>` or
`remove`. Hosted publication uses `sporades host policy publish <file>` or
`remove` with an explicit Host and Capsule target, over the existing SSH helper
boundary and lifecycle lock. The Host selects the path from its current recorded
release, never from caller-supplied storage paths. Publication validates first,
writes and syncs a temporary file, renames it atomically, and syncs the directory.
Explicit removal publishes an internal removal marker, distinct from user JSON.
It survives restart and redeploy; missing files and I/O failures are never deletion.
Changing or removing the declaration keeps the inactive stored copy.

The loader reads at startup before evaluating Capsule code or listening, then
polls the exact file every two seconds. Reads, JSON size, nesting, rules and
conditions are bounded. A complete deeply frozen generation swaps by one reference
assignment. Invalid cold configuration aborts startup. Invalid hot updates retain
the last-known-good generation and expose degraded health; successful recovery
emits a health transition. Only digest, health and aggregate local quota
diagnostics appear in the protected
readiness response; platform reload events contain only digest and health.
Issue #66 established this lifecycle independently of enforcement. Issue #67 now
consumes one generation snapshot before HTTP Capsule routing to enforce exact-path
denials. Genuine authenticated controls bypass admission; reserved targets fail
validation. Issue #68 completes non-address AND matching: methods, exact/segment-prefix
paths, canonical public headers and query-key presence. Canonicalization is pinned
in the [configuration reference](../reference/projects-and-configuration.md#request-admission-policy-publication).
Issue #69 adds exact/CIDR address conditions using only canonical
Host-authenticated identity in Hosted mode. Caddy replaces incoming internal
identity and supplies a per-runtime capability derived from the existing
Host-owned readiness token with a distinct domain. The runtime validates one
address and rejects duplicate/list/invalid input; forwarding headers never
independently grant identity. Cloudflare identity retains the existing peer
allowlist boundary. Missing identity denies potentially applicable enabled
address rules, including in Dev and local Container sessions. Mapped IPv6
normalizes to IPv4; mapped network prefixes below 96 are rejected. The capability
is filtered from Capsule endpoint headers. Issue #71 adds bounded per-process
fixed-window quotas by stable rule ID and
trusted address. Monotonic elapsed time defines windows; over quota returns
opaque 429/no-store and rounded-up Retry-After. A combined 10,000-bucket table
evicts least-recently-counted buckets deterministically and exposes only aggregate
capacity eviction counts in protected health. Compatible IDs/parameters retain
state across reload; disabling/removal/parameter changes clear affected state,
and process restart resets it. Boundary bursts and independent replica quotas
are deliberate v1 limits. Missing identity takes the existing opaque 403 path.
Issue #70 applies the same generation snapshot and trusted request attributes to
WebSocket upgrades before protocol switching, including `/__sporades/ws` Capsule
traffic. Denials return the ordinary opaque pre-switch HTTP response; quotas share
HTTP buckets. Nonmatching requests retain handshake and application transport
behavior. Reserved GET controls have no WebSocket transport and are rejected
without consulting policy or counting quota buckets.

## Consequences

Operators can edit policy without rebuilding. Capsule code has read access but
cannot write through the deployed mount. This authority boundary assumes existing
Container hardening and trusted deployer/Host administration; it is not protection
against a Host administrator. Dev reads the project seed directly and provides no
policy ownership isolation. With no declaration there is no loader, timer, policy
log or added readiness field. Polling guarantees progress without relying on
platform-specific watcher rename behavior. Under ordinary scheduling valid
updates become visible within two seconds; a blocked event loop cannot guarantee
any wall-clock service latency.

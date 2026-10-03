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
emits a health transition. Only digest and health appear in the protected readiness
response and platform reload events. Issue #66 established this lifecycle independently of enforcement. Issue #67 now
consumes one generation snapshot before HTTP Capsule routing to enforce exact-path
denials. Genuine authenticated controls bypass admission; reserved targets fail
validation. The remaining matchers, quota enforcement and WebSocket upgrades are
later slices.

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

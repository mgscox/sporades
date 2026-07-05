# Sporades Roadmap

This roadmap captures candidate features before they are promoted into concrete
PRDs and implementation issues under `.scratch/`.

Statuses:

- `candidate` - captured idea, not yet shaped.
- `design` - needs a PRD, ADR, or implementation brief.
- `ready` - shaped enough to split into implementation issues.
- `active` - currently being built.
- `deferred` - intentionally parked.

## Recommended Next Features

The recommended next features are design-stage items that are concrete enough
to shape into ADRs, PRDs, or implementation briefs. They are not ordered as one
release theme yet; promotion should clarify dependency order, acceptance bars,
and whether the work belongs in one release or separate tracks.

| Feature | Status | Why it matters | Planning |
| --- | --- | --- | --- |
| Host-generated sealed env keys | ready | Follow-up to implemented Sealed Server env: move Hosted Capsule private-key generation and storage fully into Host-server-owned key state. Host servers should generate and retain per-Hosted Capsule private keys, expose only public keys and fingerprints to the CLI, and accept Host-encrypted sealed envelopes so neither Host private keys nor plaintext secrets cross the local-to-Host boundary. Default key storage should be strict-permission Host filesystem state with optional future key-store backends, not desktop keyrings. If Host keys are lost, recovery is re-key and re-seal from source-of-truth values; Host key backup/restore belongs under a broader Host backup/restore feature. Today, `sporades host push` delivers the Host-profile private key from local configuration into persistent Host state; this design replaces that with Host-owned key generation, public-key retrieval, local re-encryption from source values, explicit Host key rotation, and re-encryption to the new Host public key. | `.scratch/host-generated-sealed-env-keys/PRD.md` |
| Database and storage ACL rules | ready | Add ACL rules declared in Capsule definition code, not `sporades.json`. ACL enforcement sits above the Database adapter as an invisible policy wrapper around the engine-agnostic Sporades DB API: app code keeps using normal `ctx.db` and file APIs, while ACL rules accept or reject operations. ACL rules should receive a constrained read-only `ctx.acl` policy context with scoped helpers such as `ctx.acl.db.get()`, `ctx.acl.db.exists()`, `ctx.acl.storage.get()`, and `ctx.acl.storage.exists()` instead of normal runtime APIs, avoiding recursion and writes while allowing database and storage policies to check each other's stable resources. ACLs are allow-by-default when no matching rule is specified, with future `sporades doctor` warnings for missing ACLs or open-to-the-world data. Support `write` as a fallback for insert, update, and delete, with operation-specific rules overriding it. Read ACLs should filter rows after fetch in the first implementation rather than compiling policy into database-specific SQL. Write ACLs should run in the mutation transaction where possible and receive previous/next row state: insert has `previous = null`, update has both, and delete has `next = null`. Public denials should be opaque, using a broad code such as `DENIED`, while internal structured logs should include detailed ACL context for developer diagnosis. Design and implementation do not need to wait for adapter extraction. The adapter provides persistence primitives but does not decide who may read or write data. Must preserve server-owned auth and avoid exposing raw policy internals to the client. | `.scratch/database-and-storage-acl-rules/PRD.md` |
| Database adapter | ready | Introduce an internal runtime-owned Database adapter boundary that translates all SQL-backed Sporades persistence into engine-specific SQL and connection behavior, including app tables, migrations, auth storage, file metadata storage, log index, system metadata, and inspection commands. Code above the adapter should remain engine-agnostic, and the adapter constructor/init path should own engine peculiarities. The first slice can start before Docker Compose support by extracting the current `node:sqlite` behavior into a no-behavior-change SQLite adapter. Later slices should coordinate with Docker Compose support to add the first service-backed SQLite-compatible adapter. Do not expose this as a public plugin API until at least two internal adapters prove the shape. | `.scratch/database-adapter/PRD.md` |
| Docker Compose support | ready | Add repeatable local provisioning for Capsule services such as databases across Dev sessions and local Container sessions. Capsule services should be declared as intent in `sporades.json`, with Sporades generating and owning Compose files under the Runtime directory. This should establish the service orchestration substrate for service-backed Database adapters, implement only the local `dev` and `deploy` lifecycle pieces it needs, and produce a Hosted Capsule design contract without implementing Host service orchestration yet. Local experience should inform whether Host servers later need Portainer or another management layer. | `.scratch/docker-compose-capsule-services/PRD.md` |

## Data And Auth Helpers

| Feature | Status | Notes |
| --- | --- | --- |
| Built-in authenticated middleware/helper | candidate | Provide a server helper for handlers that require a linked/authenticated user and should throw or return a structured auth error otherwise. |
| User preferences table and SDK | candidate | Add a Sporades-owned key-value JSON preferences store for the current authenticated user. Candidate client shape: `sporades.updateUserPrefs({ darkTheme: true, language: "en" })`. |
| Verify transaction coverage for every DB write | candidate | Audit mutations, auth writes, file metadata writes, system table writes, hosted runtime writes where applicable, and hook behavior. Promote fixes if any write path is outside an intended transaction. |
| Root server role | candidate | Define a privileged server-side role that can perform API actions without normal user authentication and may inspect runtime-owned non-app resources that normal app ACL helpers cannot see. Needs sharp boundaries so it remains a server/runtime capability, not a browser credential. |
| Teams for ACL | deferred | Add team membership as a platform concept after Database and storage ACL rules are designed. Creator is team admin; admins can invite, approve requests, promote admins, revoke membership; users can request membership, list pending requests, list teams, and leave teams. |

## Storage, Database, And Extension Plugins

| Feature | Status | Notes |
| --- | --- | --- |
| SQLite vector extension support | candidate | Load `sqlite-vector`, add `Blob()`, define vector column initialization, quantization/preload behavior, and nearest-neighbor query ergonomics. |
| Managed AWS S3 storage adapter expansion | candidate | Local MinIO-backed S3-compatible file byte storage is implemented for Dev sessions and local Container sessions. Future managed AWS S3 or external S3-compatible provider work should extend the existing internal Storage adapter/config model beyond local MinIO while preserving the `files` SDK, File metadata model, Sporades HTTP read routes, and app/client APIs. |

## Ops And Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Automated backups | candidate | Back up SQLite data and uploaded file bytes for Dev sessions, Container sessions, and Hosted Capsules. Needs restore semantics, retention, encryption, and CLI inspection. |
| Host backup and restore | candidate | Back up and restore Host-server-owned state, including Hosted Capsule registry data, persistent Capsule data, uploaded file bytes, Host-generated sealed env keys, release metadata, and route/proxy state. Needs retention, encryption, restore authorization, and disaster-recovery semantics. |
| `sporades doctor` | candidate | Diagnose local and Hosted Capsule configuration, security posture, service state, and runtime hygiene with structured warnings and hints. Candidate checks include missing ACLs, open-to-the-world data, Capsule service drift, Sealed Server env state, Public Dev session posture, and Hosted Capsule health/config mismatches. |
| OpenTelemetry hooks | candidate | Add hooks or default instrumentation points for traces, metrics, and logs without requiring app code to import OpenTelemetry directly. |
| Mail sending | candidate | Add SMTP or third-party mail provider support for server-side mail sending. Likely useful for auth, invites, notifications, and team workflows. |
| GitHub release auto-update | candidate | For a linked GitHub repository, watch for newly published releases, download the packaged Sporades release artifact, update the Hosted Capsule, and automatically roll back if deployment or verification fails. Assumes a GitHub Action already uses Sporades to build and package the release. |
| Job queue | candidate | Durable background work with retry/failure visibility. Should stay local-first unless an adapter is explicitly configured. |
| Job scheduling | candidate | Cron-like recurring jobs with persistence, missed-run behavior, timezone handling, and duplicate-run protection. Can build on or sit beside the job queue depending on design. |

## Engineering Hygiene

| Feature | Status | Notes |
| --- | --- | --- |
| Test-only internal export namespace | candidate | Move private/protected runtime helpers that are exported only for tests under a single `_csu: { ... }` export namespace. This keeps the reason for those exports explicit, preserves old-school CSU/CSC/CSCI vocabulary for support-unit internals, and makes it easy to audit or remove the test-only surface later without mistaking it for public API. |

## Promotion Rule

When a roadmap item becomes concrete enough to build:

1. Use the "To Issues" skill to create `.scratch/<feature-slug>/PRD.md` with implementation split into `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
   Ensure each feature PRD links to the relevant planning artifact from this roadmap. Ensure the PRD explicitly requires this roadmap to be updated.
2. Update the roadmap status as idea maturation progresses and work moves from
   `candidate` to `design`, `ready`, or `active`. Remove completed work from
   this roadmap once it is implemented and documented.

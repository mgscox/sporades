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
| User journey tracker | design | Gives Capsule authors an opt-in way to understand active user state and journey progress without exposing Sporades user identity, enabling online/viewing/typing-style UI, support diagnostics, and lightweight collaboration cues. | Needs PRD. Use the Data And Auth Helpers roadmap note as the source planning artifact. |

## Recently Implemented

The following recommended feature has been implemented and documented, so it no
longer belongs in the next-feature queue.

| Feature | Status | Notes |
| --- | --- | --- |
| Verify transaction coverage for every DB write | implemented | Transaction coverage is audited and hardened for app mutation execution, auth and preference workflows, file metadata and upload bookkeeping, custom endpoints, App message handlers, schema/system metadata, log index degradation, and hosted/runtime database boundaries. The audit remains in `.scratch/verify-transaction-coverage/transaction-boundary-audit.md`, and planning remains in `.scratch/verify-transaction-coverage/PRD.md` for traceability. The Log index retry queue stays a separate roadmap candidate. |
| Sporades doctor | implemented | `sporades doctor` is available as a read-only diagnostic coordinator for project configuration, security posture, Capsule authoring, Dev sessions, local Container sessions, Capsule service state, and Hosted Capsules. It reports human or JSON checks with `pass`, `warn`, `fail`, and `skip` statuses, supports `--strict --json` for CI and AFK agents, and points back to focused inspection commands such as `sporades security`, `sporades env`, `sporades deploy ssh`, `sporades host health`, `sporades host stats`, `sporades host logs`, and `sporades host ssh`. Planning remains in `.scratch/sporades-doctor/PRD.md` for traceability. |
| SSH to Docker | implemented | Container SSH access is available for local Container sessions and Hosted Capsules through top-level `ssh.authorizedKeys` entries in `sporades.json`. It remains an opt-in compatibility and emergency access path; normal management stays on `sporades deploy`, `sporades host ...`, logs, stats, and lifecycle commands. Effective SSH state is inspected explicitly with `sporades deploy ssh` and `sporades host ssh`. Planning remains in `.scratch/ssh-to-docker/PRD.md` for traceability. |
| User preferences table and SDK | implemented | Runtime-owned current-user preferences are available through `sporades/client` as `preferences.get()` and `preferences.update(...)`. Preferences are keyed by Sporades user identity, survive Anonymous session linking, follow sign-in/sign-out and local identity simulation, and notify same-user connected clients with `preferences.updated`. Planning remains in `.scratch/user-preferences-table-and-sdk/PRD.md` for traceability. |

## Data And Auth Helpers

| Feature | Status | Notes |
| --- | --- | --- |
| User journey tracker | design | Add a runtime-owned tracker, exposed through `sporades/client`, that remains disabled until client code explicitly enables it for the current Sporades user. Once enabled, Sporades creates a unique opaque `sessionId` for that browser/session and uses that identifier, not the user ID, on app-visible journey records. The tracker should store the user's current status plus optional JSON metadata such as route, view, focus state, typing state, or workflow step, with heartbeat/expiry semantics so stale status is cleaned up. The shape can follow [Appwrite Presences](https://appwrite.io/docs/products/auth/presences) as an indicative guide: a status string, metadata object, expiry/cleanup, and realtime change notifications. The Sporades design must stay privacy-first: explicit per-user enablement, no PII by default, clear disable/delete behavior, server-side linkage to auth only where needed for ownership, and app-facing APIs that deal in anonymous session status rather than identity. |
| Root server role | candidate | Define a privileged server-side role that can perform API actions without normal user authentication and may inspect runtime-owned non-app resources that normal app ACL helpers cannot see. Needs sharp boundaries so it remains a server/runtime capability, not a browser credential. |
| Teams for ACL | deferred | Add team membership as a platform concept after Database and storage ACL rules are designed. Creator is team admin; admins can invite, approve requests, promote admins, revoke membership; users can request membership, list pending requests, list teams, and leave teams. |

## Storage, Database, And Extension Plugins

| Feature | Status | Notes |
| --- | --- | --- |
| Managed AWS S3 storage adapter expansion | candidate | Local MinIO-backed S3-compatible file byte storage is implemented for Dev sessions and local Container sessions. Future managed AWS S3 or external S3-compatible provider work should extend the existing internal Storage adapter/config model beyond local MinIO while preserving the `files` SDK, File metadata model, Sporades HTTP read routes, and app/client APIs. |
| Service-backed vector support (pgvector) | candidate | Complements SQLite vector extension support for Capsules not on the SQLite Database adapter. Enable the `pgvector` extension on the existing Postgres Capsule service (no new service type) and give the Postgres Database adapter a vector field path mirroring the SQLite one: shared vector field kind, value helper, and nearest-neighbor query ergonomics above the adapter boundary (ADR 0021), engine-specific storage and kNN below it. Turns the SQLite-only "unsupported engine" error into a real second path. A dedicated vector-DB Capsule service (Qdrant/Chroma/Milvus) was considered and deferred in favor of reusing the provisioned Postgres service. |

## Ops And Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Automated backups | candidate | Back up SQLite data and uploaded file bytes for deployed Container sessions, and Hosted Capsules. Needs restore semantics, retention, encryption, and CLI inspection. 
Backup/restore is for transient data to support redployment or restore after deletion - i.e. should be
the mapped docker paths. Can be just 'tar' or similar. Likely dependent on 'Job Scheudling' |
| Host backup and restore | candidate | Back up and restore Host-server-owned state, including Hosted Capsule registry data, persistent Capsule data, uploaded file bytes, Host-generated sealed env keys, release metadata, and route/proxy state. Needs retention, encryption, restore authorization, and disaster-recovery semantics. |
| OpenTelemetry hooks | candidate | Add hooks or default instrumentation points for traces, metrics, and logs without requiring app code to import OpenTelemetry directly. |
| Log index retry queue | candidate | Add a bounded in-memory retry queue for Log index writes or pruning that fail while the JSONL log stream remains the durable append stream. Needs clear caps, flush timing, duplicate handling, shutdown behavior, and inspection of degraded indexing without making Log index availability part of app/auth/file workflow success. |
| Mail sending | candidate | Add SMTP or third-party mail provider support for server-side mail sending. Likely useful for auth, invites, notifications, and team workflows. |
| GitHub release auto-update | candidate | For a linked GitHub repository, watch for newly published releases, download the packaged Sporades release artifact, update the Hosted Capsule, and automatically roll back if deployment or verification fails. Assumes a GitHub Action already uses Sporades to build and package the release. |
| Job queue | candidate | Durable background work with retry/failure visibility. Should stay sqlite-first unless an adapter is explicitly configured. Job and Queue shape to align with minimal BullMQ scope to 
support functionality and allow its future implementation via adapter. Suggestion, use
(supaqueue)[https://github.com/emirce/supaqueue] as a basis (in-memory dependency-free nodejs queue) |
| Job scheduling | candidate | Cron-like recurring jobs with persistence, missed-run behavior, timezone handling, and duplicate-run protection. Can build on or sit beside the job queue depending on design.
Dependent upon 'Job Queue' |

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

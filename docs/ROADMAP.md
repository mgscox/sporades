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
| Built-in authenticated middleware/helper | ready | Small, self-contained server helper for handlers that require a linked/authenticated user, throwing or returning a structured auth error otherwise. Removes repeated manual `ctx.auth` checks and standardizes the denial shape on the existing server auth surface. | `.scratch/built-in-auth-helper/PRD.md` |
| SQLite vector extension support | ready | Enables embeddings and nearest-neighbor search in the default SQLite runtime without an external vector store. Scoped to loading the SQLite vector extension, a `Blob()` helper, vector column initialization, quantization/preload behavior, and query ergonomics. | `.scratch/sqlite-vector-extension/PRD.md` |

## Data And Auth Helpers

| Feature | Status | Notes |
| --- | --- | --- |
| User preferences table and SDK | candidate | Add a Sporades-owned key-value JSON preferences store for the current authenticated user. Candidate client shape: `sporades.updateUserPrefs({ darkTheme: true, language: "en" })`. |
| Verify transaction coverage for every DB write | candidate | Audit mutations, auth writes, file metadata writes, system table writes, hosted runtime writes where applicable, and hook behavior. Promote fixes if any write path is outside an intended transaction. |
| Root server role | candidate | Define a privileged server-side role that can perform API actions without normal user authentication and may inspect runtime-owned non-app resources that normal app ACL helpers cannot see. Needs sharp boundaries so it remains a server/runtime capability, not a browser credential. |
| Teams for ACL | deferred | Add team membership as a platform concept after Database and storage ACL rules are designed. Creator is team admin; admins can invite, approve requests, promote admins, revoke membership; users can request membership, list pending requests, list teams, and leave teams. |

## Storage, Database, And Extension Plugins

| Feature | Status | Notes |
| --- | --- | --- |
| Managed AWS S3 storage adapter expansion | candidate | Local MinIO-backed S3-compatible file byte storage is implemented for Dev sessions and local Container sessions. Future managed AWS S3 or external S3-compatible provider work should extend the existing internal Storage adapter/config model beyond local MinIO while preserving the `files` SDK, File metadata model, Sporades HTTP read routes, and app/client APIs. |

## Ops And Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Automated backups | candidate | Back up SQLite data and uploaded file bytes for deployed Container sessions, and Hosted Capsules. Needs restore semantics, retention, encryption, and CLI inspection. 
Backup/restore is for transient data to support redployment or restore after deletion - i.e. should be
the mapped docker paths. Can be just 'tar' or similar. Likely dependent on 'Job Scheudling' |
| Host backup and restore | candidate | Back up and restore Host-server-owned state, including Hosted Capsule registry data, persistent Capsule data, uploaded file bytes, Host-generated sealed env keys, release metadata, and route/proxy state. Needs retention, encryption, restore authorization, and disaster-recovery semantics. |
| `sporades doctor` | candidate | Diagnose local and Hosted Capsule configuration, security posture, service state, and runtime hygiene with structured warnings and hints. Candidate checks include missing ACLs, open-to-the-world data, Capsule service drift, Sealed Server env state, Public Dev session posture, and Hosted Capsule health/config mismatches. |
| OpenTelemetry hooks | candidate | Add hooks or default instrumentation points for traces, metrics, and logs without requiring app code to import OpenTelemetry directly. |
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

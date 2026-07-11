# Sporades Roadmap

This roadmap captures candidate features before they are promoted into concrete
PRDs and implementation issues under `.scratch/`.

Statuses:

- `candidate` - captured idea, not yet shaped.
- `design` - needs a PRD, ADR, or implementation brief.
- `ready` - shaped enough to split into implementation issues.
- `active` - currently being built.
- `deferred` - intentionally parked.
- `implemented` - delivered and documented; retained under Recently Implemented
  for traceability rather than remaining in the next-feature queue.

## Recommended Next Features

The recommended next features are concrete enough to shape into ADRs, PRDs,
implementation briefs, or implementation issues. They are not ordered as one
release theme yet; promotion should clarify dependency order, acceptance bars,
and whether the work belongs in one release or separate tracks.

| Feature | Status | Why it matters | Planning |
| --- | --- | --- | --- |
| Multi-framework client toolchains | design | Expands Capsule client support beyond React and Preact while preserving one Sporades-owned Bundle pipeline, deterministic Dev/Container/Hosted behavior, and framework-native authoring. The intended initial set is Vanilla TypeScript, React, Preact, Vue, Svelte, SolidJS, Lit, and Inferno. | Needs a PRD covering an internal client-toolchain adapter seam, esbuild and Vite capability rules, a normalized public asset tree instead of the fixed `client.js` release assumption, framework-neutral transport subscriptions, native hooks/composables/stores/signals/controllers, scaffold and dependency generation, structured build events, and Dev-session refresh behavior. The design must revisit or supersede ADR 0010's fixed `/client.js` and user-owned `index.html` contract while preserving explicit HTML ownership semantics. Angular and server-owning meta-frameworks are out of scope because they would replace rather than fit the Sporades project and runtime model. |

## Recently Implemented

The following recommended features have been implemented and documented, so they
no longer belong in the next-feature queue.

| Feature | Status | Notes |
| --- | --- | --- |
| User journey tracker | implemented | Capsules can explicitly enable privacy-safe, client-only Journey publication with page-runtime consent, lazy server-owned sessions, reconnect and inactivity segmentation, bounded latest-state TTL buffering, flat multi-session records, and snapshot-first realtime observation. The `campfire` scaffold is the complete exemplar. Planning remains in `.scratch/user-journey-tracker/PRD.md` for traceability. |
| Job scheduling | implemented | Capsule server code declares named server-only Schedules with numeric five-field cron, IANA timezone and daylight-saving semantics, JSON-safe static or dynamic payloads, bounded `skip`/`latest` recovery, durable reconciliation, duplicate-protected occurrence creation, ordinary Privileged Job execution, and JSON-only inspection across Dev, Container, and Hosted Capsules. Planning remains in `.scratch/job-scheduling/PRD.md` for traceability. |
| Job queue | implemented | Capsule server code declares durable server-only Jobs with `job()` and uses the runtime-owned queue for current-user and Privileged server role actors. The queue provides one-time delayed availability, bounded retry, cancellation, lease recovery, at-least-once delivery, actor-scoped app inspection, and bounded JSON-only administrator inspection across Dev sessions, local Container sessions, and Hosted Capsules. Implemented Job scheduling builds on this queue and leaves execution, retries, cancellation, leases, and results under its contract. Planning remains in `.scratch/job-queue/PRD.md` for traceability. |
| Privileged server role | implemented | Capsule server code can call `ctx.privileged.run(...)` from trusted server surfaces to run explicit audited userless work with a derived privileged context. The role is not a Capsule role, app admin, user, session, team member, service account, or browser credential; Capsule admin authorization remains separate as Capsule roles checked through normal ACL rules. Privileged runs emit the implemented Privileged audit event lifecycle (`started`, `completed`, `errored`, `finished`), preserve generated runtime parity, expose narrow DB and File operations through existing runtime boundaries, and provide the explicit actor boundary used by Privileged Jobs, including Jobs created by implemented Schedules. Planning remains in `.scratch/privileged-server-role/PRD.md` for traceability. |
| Privileged audit event contract | implemented | Privileged audit events are implemented as a narrow platform-owned JSONL audit surface, not a new audit database or centralized logging system. The implemented Privileged audit event contract records actor kind, operation, surface, Capsule identity, target resource, outcome, safe error code, and redacted bounded metadata, and current coverage includes Sporades-controlled SSH configuration, lifecycle, and inspection events. App `ctx.log` and browser/client credentials cannot forge privileged audit events. Real `sshd` auth/session capture remains future scanner work. Implemented scheduled Privileged Jobs reuse the existing Privileged audit boundary. Planning remains in `.scratch/privileged-audit-event-contract/PRD.md` and `.scratch/privileged-audit-event-contract/ssh-daemon-session-log-scanner-spike.md` for traceability. |
| Verify transaction coverage for every DB write | implemented | Transaction coverage is audited and hardened for app mutation execution, auth and preference workflows, file metadata and upload bookkeeping, custom endpoints, App message handlers, schema/system metadata, log index degradation, and hosted/runtime database boundaries. The audit remains in `.scratch/verify-transaction-coverage/transaction-boundary-audit.md`, and planning remains in `.scratch/verify-transaction-coverage/PRD.md` for traceability. The Log index retry queue stays a separate roadmap candidate. |
| Sporades doctor | implemented | `sporades doctor` is available as a read-only diagnostic coordinator for project configuration, security posture, Capsule authoring, Dev sessions, local Container sessions, Capsule service state, and Hosted Capsules. It reports human or JSON checks with `pass`, `warn`, `fail`, and `skip` statuses, supports `--strict --json` for CI and AFK agents, and points back to focused inspection commands such as `sporades security`, `sporades env`, `sporades deploy ssh`, `sporades host health`, `sporades host stats`, `sporades host logs`, and `sporades host ssh`. Planning remains in `.scratch/sporades-doctor/PRD.md` for traceability. |
| SSH to Docker | implemented | Container SSH access is available for local Container sessions and Hosted Capsules through top-level `ssh.authorizedKeys` entries in `sporades.json`. It remains an opt-in compatibility and emergency access path; normal management stays on `sporades deploy`, `sporades host ...`, logs, stats, and lifecycle commands. Effective SSH state is inspected explicitly with `sporades deploy ssh` and `sporades host ssh`. Planning remains in `.scratch/ssh-to-docker/PRD.md` for traceability. |
| User preferences table and SDK | implemented | Runtime-owned current-user preferences are available through `sporades/client` as `preferences.get()` and `preferences.update(...)`. Preferences are keyed by Sporades user identity, survive Anonymous session linking, follow sign-in/sign-out and local identity simulation, and notify same-user connected clients with `preferences.updated`. Planning remains in `.scratch/user-preferences-table-and-sdk/PRD.md` for traceability. |

## Data And Auth Helpers

| Feature | Status | Notes |
| --- | --- | --- |
| Capsule roles | design | Define Capsule-scoped user authorization labels, such as app-defined admin roles, for use in normal ACL rules over one Capsule's DB, files, and storage resources. Capsule roles are separate from the Privileged server role per ADR 0027: they do not create userless system-owned execution, do not grant platform/runtime authority, and should not become a global role on runtime-owned Sporades auth users. Needs a separate PRD before implementation. |
| Teams for ACL | deferred | Add team membership as a platform concept after Database and storage ACL rules are designed. Creator is team admin; admins can invite, approve requests, promote admins, revoke membership; users can request membership, list pending requests, list teams, and leave teams. |

## Storage, Database, And Extension Plugins

| Feature | Status | Notes |
| --- | --- | --- |
| Managed AWS S3 storage adapter expansion | candidate | Local MinIO-backed S3-compatible file byte storage is implemented for Dev sessions and local Container sessions. Future managed AWS S3 or external S3-compatible provider work should extend the existing internal Storage adapter/config model beyond local MinIO while preserving the `files` SDK, File metadata model, Sporades HTTP read routes, and app/client APIs. |
| Service-backed vector support (pgvector) | candidate | Complements SQLite vector extension support for Capsules not on the SQLite Database adapter. Enable the `pgvector` extension on the existing Postgres Capsule service (no new service type) and give the Postgres Database adapter a vector field path mirroring the SQLite one: shared vector field kind, value helper, and nearest-neighbor query ergonomics above the adapter boundary (ADR 0021), engine-specific storage and kNN below it. Turns the SQLite-only "unsupported engine" error into a real second path. A dedicated vector-DB Capsule service (Qdrant/Chroma/Milvus) was considered and deferred in favor of reusing the provisioned Postgres service. |

## Ops And Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Automated backups | candidate | Back up SQLite data and uploaded file bytes for deployed Container sessions and Hosted Capsules. Needs restore semantics, retention, encryption, and CLI inspection. Backup/restore is for transient data to support redeployment or restore after deletion; i.e. the mapped Docker paths. Can be just `tar` or similar. Likely dependent on Job scheduling. |
| Host backup and restore | candidate | Back up and restore Host-server-owned state, including Hosted Capsule registry data, persistent Capsule data, uploaded file bytes, Host-generated sealed env keys, release metadata, and route/proxy state. Needs retention, encryption, restore authorization, and disaster-recovery semantics. |
| OpenTelemetry hooks | candidate | Add hooks or default instrumentation points for traces, metrics, and logs without requiring app code to import OpenTelemetry directly. |
| Log index retry queue | candidate | Add a bounded in-memory retry queue for Log index writes or pruning that fail while the JSONL log stream remains the durable append stream. Needs clear caps, flush timing, duplicate handling, shutdown behavior, and inspection of degraded indexing without making Log index availability part of app/auth/file workflow success. |
| Mail sending | candidate | Add SMTP or third-party mail provider support for server-side mail sending. Likely useful for auth, invites, notifications, and team workflows. |
| GitHub release auto-update | candidate | For a linked GitHub repository, watch for newly published releases, download the packaged Sporades release artifact, update the Hosted Capsule, and automatically roll back if deployment or verification fails. Assumes a GitHub Action already uses Sporades to build and package the release. |

## Engineering Hygiene

| Feature | Status | Notes |
| --- | --- | --- |
| Test-only internal export namespace | candidate | Move private/protected runtime helpers that are exported only for tests under a single `_csu: { ... }` export namespace. This keeps the reason for those exports explicit, preserves old-school CSU/CSC/CSCI vocabulary for support-unit internals, and makes it easy to audit or remove the test-only surface later without mistaking it for public API. |

## Promotion Rule

When a roadmap item becomes concrete enough to build:

1. Use the "To Issues" skill to create `.scratch/<feature-slug>/PRD.md` with implementation split into `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
   Ensure each feature PRD links to the relevant planning artifact from this roadmap. Ensure the PRD explicitly requires this roadmap to be updated.
2. Update the roadmap status as idea maturation progresses and work moves from
   `candidate` to `design`, `ready`, or `active`. Once work is implemented and
   documented, move it out of the candidate/recommended queue into Recently
   Implemented with status `implemented` and retain its planning link for
   traceability.

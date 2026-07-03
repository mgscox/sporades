# Sporades Roadmap

This roadmap captures candidate features before they are promoted into concrete
PRDs and implementation issues under `.scratch/`.

Statuses:

- `candidate` - captured idea, not yet shaped.
- `design` - needs a PRD, ADR, or implementation brief.
- `ready` - shaped enough to split into implementation issues.
- `active` - currently being built.
- `done` - implemented and documented.
- `deferred` - intentionally parked.

## Recommended Next Features

| Feature | Status | Why it matters | Planning |
| --- | --- | --- | --- |
| Server security defaults | candidate | Sets safe HTTP defaults for CORS, headers, auth callbacks, custom endpoints, file URLs, and local dev exceptions. | `.scratch/post-v2-platform-hardening-and-ops/issues/03-add-server-security-defaults.md` |
| Hardened secrets | candidate | Replaces plaintext project-root Server env files as the long-term default for provider credentials and other secrets. | `.scratch/post-v2-platform-hardening-and-ops/issues/01-replace-server-env-files-with-hardened-secrets.md` |
| Container filesystem hardening | candidate | Makes Container sessions and Hosted Capsules safer with non-root runtime, explicit writable paths, read-only filesystem posture, and Docker hardening. | `.scratch/post-v2-platform-hardening-and-ops/issues/02-harden-base-image-and-container-filesystem.md` |
| Central JSON logging | candidate | Gives developers and agents one structured way to watch platform logs, app logs, and `ctx.log` output. | `.scratch/post-v2-platform-hardening-and-ops/issues/05-centralize-json-server-logging.md` |
| Fatal runtime restart policy | candidate | Defines restart, backoff, lifecycle-hook, and JSON output behavior for unhandled rejections, uncaught exceptions, and fatal runtime paths. | `.scratch/post-v2-platform-hardening-and-ops/issues/06-handle-fatal-runtime-paths-with-restart-policy.md` |

## Data And Auth Helpers

| Feature | Status | Notes |
| --- | --- | --- |
| Built-in authenticated middleware/helper | candidate | Provide a server helper for handlers that require a linked/authenticated user and should throw or return a structured auth error otherwise. |
| User preferences table and SDK | candidate | Add a Sporades-owned key-value JSON preferences store for the current authenticated user. Candidate client shape: `sporades.updateUserPrefs({ darkTheme: true, language: "en" })`. |
| Verify transaction coverage for every DB write | candidate | Audit mutations, auth writes, file metadata writes, system table writes, hosted runtime writes where applicable, and hook behavior. Promote fixes if any write path is outside an intended transaction. |
| Database and storage ACL rules | design | Explore a simplified Firebase-rules-like access model for app tables and file storage. Must preserve server-owned auth and avoid exposing raw policy internals to the client. |
| Teams for ACL | design | Add team membership as a platform concept: creator is team admin; admins can invite, approve requests, promote admins, revoke membership; users can request membership, list pending requests, list teams, and leave teams. |
| Root server role | candidate | Define a privileged server-side role that can perform API actions without normal user authentication. Needs sharp boundaries so it remains a server/runtime capability, not a browser credential. |

## Storage, Database, And Extension Plugins

| Feature | Status | Notes |
| --- | --- | --- |
| SQLite vector extension support | candidate | Load `sqlite-vector`, add `Blob()`, define vector column initialization, quantization/preload behavior, and nearest-neighbor query ergonomics. |
| S3-compatible storage plugin | candidate | Allow uploaded bytes to live in S3-compatible object storage while preserving the existing `files` SDK and File metadata model. |
| Database driver plugin | design | Explore replacing the SQLite implementation behind an abstract driver while preserving the app-facing table API, migrations, auth storage, files metadata, and inspection commands. |

## Ops And Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Automated backups | candidate | Back up SQLite data and uploaded file bytes for Dev sessions, Container sessions, and Hosted Capsules. Needs restore semantics, retention, encryption, and CLI inspection. |
| OpenTelemetry hooks | candidate | Add hooks or default instrumentation points for traces, metrics, and logs without requiring app code to import OpenTelemetry directly. |
| Mail sending | candidate | Add SMTP or third-party mail provider support for server-side mail sending. Likely useful for auth, invites, notifications, and team workflows. |
| Job queue | candidate | Durable background work with retry/failure visibility. Should stay local-first unless an adapter is explicitly configured. |
| Job scheduling | candidate | Cron-like recurring jobs with persistence, missed-run behavior, timezone handling, and duplicate-run protection. Can build on or sit beside the job queue depending on design. |

## Promotion Rule

When a roadmap item becomes concrete enough to build:

1. Use the "To Issues" skill to create `.scratch/<feature-slug>/PRD.md` with implementation split into `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
   Ensure each feature PRD links to the relevant planning artifact from this roadmap. Ensure the PRD explicitly requires this roadmap to be updated.
2. Update the roadmap status as idea maturation progresses and work and moves from `candidate` to `design`, `ready`, `active`, and `done`.

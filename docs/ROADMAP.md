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

The recommended next features form one cohesive post-v2 release theme:
production readiness for Hosted Capsules and Container sessions. Items should
remain independently shippable, but planning should treat them as one hardening
and operations arc rather than unrelated roadmap entries.

The success bar for this theme is agent-operable Hosted Capsules: an agent
should be able to safely deploy, observe, diagnose, and recover a Hosted Capsule
without scraping logs, SSH spelunking, or guessing whether a failure comes from
security configuration, runtime crashes, secrets, or container filesystem
permissions.

The theme should cover Dev sessions, local Container sessions, and Hosted
Capsules, but Hosted Capsules are the acceptance bar. Dev sessions should stay
convenient and forgiving, local Container sessions should provide a
production-like verification surface, and Hosted Capsules should prove the
production-readiness behavior end to end.

| Feature | Status | Why it matters | Planning |
| --- | --- | --- | --- |
| Server security defaults | done | Adds per-Capsule security policy defaults in `sporades.json`: same-origin CORS, Dev-session localhost/127.0.0.1 ergonomics, explicit Public Dev mode, conservative headers, technology-header suppression, report-only CSP defaults, active CSP enforcement, and CLI/Host policy inspection. | `.scratch/production-readiness/issues/01-add-capsule-security-policy-defaults.md` |
| Hardened secrets | done | Sealed Server env now replaces plaintext project-root Server env files as the long-term default, with CLI import/export and Host-profile re-encryption while preserving `ctx.env`. | `.scratch/production-readiness/issues/03-add-sealed-server-env.md` |
| Host-managed sealed env keys | design | Move Hosted Capsule Sealed Server env private keys into Host-server-owned key state so Host private keys are generated on the Host server, never copied from developer machines during push, and recoverable through explicit Host key rotation plus re-encryption from the user's source-of-truth values. Needs an ADR covering storage path, permissions, public-key retrieval, rotation, and encrypted-at-rest options. | TBD |
| Container filesystem hardening | done | Adds the Sporades-owned Node 22 Base image, non-root runtime user, explicit writable data paths, read-only release mounts, Base image labels/version reporting, and Host-visible update policy. | `.scratch/production-readiness/issues/04-add-hardened-base-image-and-filesystem-model.md` |
| Central JSON logging | done | App `ctx.log` and platform runtime events now share a redacted `sporades.log.v1` envelope, durable JSONL stream, bounded SQLite recent index, CLI inspection, and Docker stdout visibility for Container sessions and Hosted Capsules. | `.scratch/production-readiness/issues/02-add-centralized-json-logging.md` |
| Fatal runtime restart policy | done | Adds mode-specific fatal restart behavior: Dev-session automatic restart/logging, bounded Docker restart policy for local Container sessions and Hosted Capsules, Hosted unavailable routing on failed starts, and opt-in release-verification fallback to the previous release only during verification. | `.scratch/production-readiness/issues/05-add-fatal-runtime-restart-policy.md` |

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
| GitHub release auto-update | candidate | For a linked GitHub repository, watch for newly published releases, download the packaged Sporades release artifact, update the Hosted Capsule, and automatically roll back if deployment or verification fails. Assumes a GitHub Action already uses Sporades to build and package the release. |
| Job queue | candidate | Durable background work with retry/failure visibility. Should stay local-first unless an adapter is explicitly configured. |
| Job scheduling | candidate | Cron-like recurring jobs with persistence, missed-run behavior, timezone handling, and duplicate-run protection. Can build on or sit beside the job queue depending on design. |

## Promotion Rule

When a roadmap item becomes concrete enough to build:

1. Use the "To Issues" skill to create `.scratch/<feature-slug>/PRD.md` with implementation split into `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
   Ensure each feature PRD links to the relevant planning artifact from this roadmap. Ensure the PRD explicitly requires this roadmap to be updated.
2. Update the roadmap status as idea maturation progresses and work and moves from `candidate` to `design`, `ready`, `active`, and `done`.

# Post-v2 Platform Hardening and Ops Markers

## Overview

This planning area captures platform hardening and operations work that is intentionally outside the Sporades v2 release. The goal is to keep these ideas visible without expanding v2 beyond uploads, app messages, scaffold templates, guestbook, and provider auth.

This is not an implementation PRD yet. It is a parking lot for future PRDs and implementation issues.

## Scope Boundary

Target release: post-v2, exact version unassigned.

These markers must not be implemented as part of v2 unless maintainers explicitly promote a marker into `.scratch/sporades-v2/PRD.md`.

## Markers

| Marker | Future target | Planning artifact |
| --- | --- | --- |
| Move from `.env` files to hardened secrets. | Post-v2, unassigned | `issues/01-replace-server-env-files-with-hardened-secrets.md` |
| Harden the Docker build, including read-only folders where appropriate. | Post-v2, unassigned | `issues/02-harden-base-image-and-container-filesystem.md` |
| Harden the server, including CORS and helmet-style defaults. | Post-v2, unassigned | `issues/03-add-server-security-defaults.md` |
| Add automatic OpenTelemetry so agents can monitor running apps. | Post-v2, unassigned | `issues/04-add-automatic-opentelemetry.md` |
| Add JSON server logging to a centralized logger so agents can watch. | Post-v2, unassigned | `issues/05-centralize-json-server-logging.md` |
| Gracefully restart the server on unhandled rejection and similar fatal paths. | Post-v2, unassigned | `issues/06-handle-fatal-runtime-paths-with-restart-policy.md` |
| Add SQLite vector extension support for AI tasks. | Post-v2, unassigned | `issues/07-evaluate-vector-storage-extension.md` |
| Add a job queue using something like Bull. | Post-v2, unassigned | `issues/08-add-job-queue.md` |
| Add job scheduling with a cron-like system. | Post-v2, unassigned | `issues/09-add-job-scheduling.md` |

## Non-Goals

- Do not add any hardening, observability, vector storage, queue, or scheduling implementation as part of this planning capture.
- Do not change v2 acceptance criteria.
- Do not require maintainers to pick a concrete future version yet.

## Open Planning Questions

- Which markers belong in the first post-v2 release versus later releases?
- Which markers need ADRs before implementation?
- Which markers should be kept local-first only, and which should be designed for future remote hosting?

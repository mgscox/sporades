# Capture post-v2 platform hardening and ops markers

Status: done

## What to build

Keep the post-v2 platform ideas visible without allowing them to expand the v2 release. This issue is a parking lot for later PRDs and should be split before implementation.

Resolution: split into `.scratch/post-v2-platform-hardening-and-ops/` as post-v2 planning artifacts. No hardening or ops features were implemented for v2.

## Markers

- Move from `.env` files to hardened secrets.
- Harden the Docker build, including read-only folders where appropriate.
- Harden the server, including CORS and helmet-style defaults.
- Add automatic OpenTelemetry so agents can monitor running apps.
- Add JSON server logging to a centralized logger so agents can watch.
- Gracefully restart the server on unhandled rejection and similar fatal paths.
- Add SQLite vector extension support for AI tasks.
- Add a job queue using something like Bull.
- Add job scheduling with a cron-like system.

## Acceptance criteria

- [x] Each marker is reviewed and either split into a dedicated future issue/PRD or explicitly deferred.
- [x] The future version target for each marker is recorded once planning begins.
- [x] No marker is implemented as part of v2 unless it is promoted into the v2 PRD by maintainers.

## Blocked by

None - planning-only issue.

## Planning split

- `.scratch/post-v2-platform-hardening-and-ops/PRD.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/01-replace-server-env-files-with-hardened-secrets.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/02-harden-base-image-and-container-filesystem.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/03-add-server-security-defaults.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/04-add-automatic-opentelemetry.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/05-centralize-json-server-logging.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/06-handle-fatal-runtime-paths-with-restart-policy.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/07-evaluate-vector-storage-extension.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/08-add-job-queue.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/09-add-job-scheduling.md`

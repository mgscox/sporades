# Capture post-v2 platform hardening and ops markers

Status: needs-triage

## What to build

Keep the post-v2 platform ideas visible without allowing them to expand the v2 release. This issue is a parking lot for later PRDs and should be split before implementation.

## Markers

- Move from `.env` files to hardened secrets.
- Harden the Docker build, including read-only folders where appropriate.
- Harden the server, including CORS and helmet-style defaults.
- Add automatic OpenTelemetry so agents can monitor running apps.
- Add JSON server logging to a centralized logger so agents can watch.
- Gracefully restart the server on unhandled rejection and similar fatal paths.
- Add a vector-storage extension to MySQL for AI tasks.
- Add a job queue using something like Bull.
- Add job scheduling with a cron-like system.

## Acceptance criteria

- [ ] Each marker is reviewed and either split into a dedicated future issue/PRD or explicitly deferred.
- [ ] The future version target for each marker is recorded once planning begins.
- [ ] No marker is implemented as part of v2 unless it is promoted into the v2 PRD by maintainers.

## Blocked by

None - planning-only issue.


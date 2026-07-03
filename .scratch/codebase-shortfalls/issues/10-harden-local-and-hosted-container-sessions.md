# Harden local and hosted Container sessions

Status: done

## What to build

Improve the Docker runtime posture for local Container sessions and Hosted Capsules. Running Capsules should avoid unnecessary privileges and should make write boundaries explicit: runtime files should remain read-only, data directories should remain writable, and containers should use safer defaults where Docker supports them.

This slice should be practical rather than performative. Add hardening that can be verified automatically and documented clearly for both local and hosted paths.

## Acceptance criteria

- [ ] Local Container session Docker arguments include tested hardening defaults where compatible with the current base image.
- [ ] Hosted Capsule Docker arguments include matching or intentionally documented hardening defaults.
- [ ] Runtime Bundle files and config remain mounted read-only.
- [ ] SQLite data and platform-managed file storage remain writable across restarts.
- [ ] Tests verify the generated Docker arguments for both local and hosted Container sessions.

## Blocked by

None - can start immediately

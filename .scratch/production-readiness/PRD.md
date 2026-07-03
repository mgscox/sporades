# Production Readiness

## Overview

This release theme makes Hosted Capsules agent-operable. An agent should be
able to safely deploy, observe, diagnose, and recover a Hosted Capsule without
scraping logs, SSH spelunking, or guessing whether a failure comes from security
configuration, runtime crashes, secrets, or container filesystem permissions.

The work also covers Dev sessions and local Container sessions. Dev sessions
should remain convenient and forgiving, local Container sessions should provide
a production-like verification surface, and Hosted Capsules are the acceptance
bar.

## Source Planning

- `docs/ROADMAP.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/01-replace-server-env-files-with-hardened-secrets.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/02-harden-base-image-and-container-filesystem.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/03-add-server-security-defaults.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/05-centralize-json-server-logging.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/06-handle-fatal-runtime-paths-with-restart-policy.md`

## Scope

- Add per-Capsule security policy in `sporades.json`, with safe defaults for
  CORS, CSP, and security headers.
- Add centralized JSON logging with a JSONL log stream, bounded SQLite log
  index, shared event envelope, redaction, and CLI/Host inspection.
- Add fatal runtime restart policy across Dev sessions, local Container
  sessions, and Hosted Capsules.
- Add Sealed Server env as the hardened successor to plaintext Server env
  files while preserving `ctx.env`.
- Add a thin Sporades-owned Base image and hardened container filesystem model
  with per-Capsule Base image update policy.
- Update `docs/ROADMAP.md` as issues move through implementation.

## Non-Goals

- Do not replace `ctx.env` with a new `ctx.secrets` API.
- Do not make Host profiles override per-Capsule security policy.
- Do not make automatic fallback to a prior release apply to arbitrary runtime
  crashes after a release has already been verified or accepted.
- Do not create a dashboard.
- Do not turn Sealed Server env into a banking-grade vault; the goal is
  practical protection against accidental plaintext leakage and CLI-first
  promotion to Host servers.

## Product Decisions

- Security policy lives in `sporades.json`, not server Capsule code.
- Security policy is per-Capsule. Host commands may report effective policy but
  do not override it in this release theme.
- CORS is Capsule-configurable, defaults to same-origin, and requires explicit
  cross-origin configuration for Container sessions and Hosted Capsules.
- Dev sessions allow both `localhost` and `127.0.0.1` by default, and support an
  explicit Public Dev session mode.
- CSP is Capsule-configurable and defaults to report-only mode with reasonable
  React/Preact scaffold defaults.
- Technology-revealing headers are suppressed by default and conservative
  security headers are emitted by default.
- Central logging uses one shared JSON envelope for app and platform events.
- Logs are emitted to a JSONL log stream and indexed into SQLite for bounded
  recent inspection.
- Container sessions and Hosted Capsules emit JSON log events to Docker stdout.
- Structured log data is redacted by default and capped by size; raw request
  bodies are not logged by default.
- Restart policy applies across Dev sessions, local Container sessions, and
  Hosted Capsules with mode-specific behavior.
- Hosted fallback to a prior release is optional and only applies during release
  verification.
- Sealed Server env uses portable public/private key encryption with Node
  `crypto`, stores sealed material in ignored Runtime or Host state by default,
  and keeps `ctx.env` as the app-facing API.
- Private keys are never committed and are not included in exported sealed
  envelopes.
- The hardened Base image is a thin Sporades-owned image.
- Base image security updates are per-Capsule policy: `host-managed` by default,
  plus `auto-patch` and `manual`.
- Persistent Capsule data must survive Base image replacement.

## User Stories

- As an agent/operator, I can inspect a Capsule's effective HTTP security
  posture before and after it is hosted.
- As an agent/operator, I can observe app and platform behavior through
  structured logs instead of scraping text output.
- As an agent/operator, I can diagnose and recover from runtime crashes with
  predictable restart/backoff behavior and structured failure output.
- As a developer/operator, I can avoid plaintext project-root secret files while
  keeping `ctx.env` and promoting configuration from local development to Host
  servers.
- As an agent/operator, I can run Container sessions and Hosted Capsules with a
  predictable hardened filesystem and visible Base image update policy.

## Implementation Issues

- `issues/01-add-capsule-security-policy-defaults.md`
- `issues/02-add-centralized-json-logging.md`
- `issues/03-add-sealed-server-env.md`
- `issues/04-add-hardened-base-image-and-filesystem-model.md`
- `issues/05-add-fatal-runtime-restart-policy.md`

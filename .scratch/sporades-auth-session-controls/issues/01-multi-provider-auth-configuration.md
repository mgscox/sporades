Status: complete

# Multi-Provider Auth Configuration

## What to build

Extend Sporades auth configuration so an app can enable multiple auth providers at once, including `anonymous`, `google`, and the future `email` provider, while preserving compatibility with existing apps that still use the current single auth mode.

This should be a test-driven design task. Work in red-green-refactor cycles, one observable behavior at a time, using public CLI/runtime behavior rather than private implementation details.

## Acceptance criteria

- [x] Existing apps using the current single-provider auth configuration continue to run without changes.
- [x] New configuration can represent multiple enabled providers and reports them through auth status without exposing secrets.
- [x] Runtime validation accepts valid multi-provider combinations and rejects unsupported provider names with structured errors and actionable hints.
- [x] Google OAuth behavior remains compatible with the existing provider setup and callback flow.
- [x] Documentation describes the multi-provider configuration shape and its backwards compatibility.
- [x] Tests cover the CLI status/configuration behavior and at least one runtime validation path.

## Blocked by

None - can start immediately

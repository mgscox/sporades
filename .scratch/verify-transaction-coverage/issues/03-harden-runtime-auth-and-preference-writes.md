Status: done

# Harden Runtime Auth And Preference Writes

## Parent

.scratch/verify-transaction-coverage/PRD.md

## What to build

Verify and fix transaction coverage for runtime-owned identity and preference
workflows. This includes Anonymous session creation, email sign-up and sign-in,
provider linking, OAuth state consumption, session rotation, sign-out/session
deletion where applicable, and current-user preference read-modify-write
updates. Failed auth actions must leave auth storage in a known and predictable
state; for example, a failed email sign-up must not leave a user record behind.

## Acceptance criteria

- [x] Multi-write auth workflows either run inside an adapter-owned transaction or are split into explicitly safe single-statement operations.
- [x] A failed email sign-up leaves no created user or usable partial auth state behind.
- [x] OAuth state consumption cannot leave reusable state after a downstream failure; the user must restart the local OAuth flow rather than replaying the same callback.
- [x] Failed sign-in/session rotation keeps the old Session token valid and does not expose a new token.
- [x] Provider linking avoids partially updated auth user/session state.
- [x] Current-user preference updates preserve their read-modify-write transaction and have rollback coverage for failed saves.
- [x] Tests cover the highest-risk auth and preference failure paths through runtime-facing helpers or client transport behavior.

## Blocked by

- .scratch/verify-transaction-coverage/issues/01-audit-db-write-transaction-boundaries.md

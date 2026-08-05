Status: ready-for-agent

# Extend Conformance Coverage To Auth Storage

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Bring the whole runtime-owned auth storage surface under the conformance
specification, so Sessions, Provider identities, email credentials, and Reset
codes behave identically on every engine.

This is where the highest-consequence divergences were found, and the seeded
cases from the tracer bullet only cover the specific methods that were already
broken. The neighbouring methods on the same surface have never been verified on
anything but SQLite.

Cover the Session lifecycle including creation, lookup with the joined user,
refresh, provenance changes, rotation, single deletion, and deletion of every
Session for one Sporades user. Cover Provider identity lookup by provider and
subject, and the legacy lookup by provider email. Cover email credential
creation, existence, password update, and lookup with the joined user. Cover the
Reset code lifecycle: issuing, lookup by selector, counting outstanding
unexpired codes, deleting every code for a user, and pruning expired codes.

Two behaviours need care because they encode security decisions rather than
storage mechanics. The reserved Privileged server role identity must be
unreadable as an ordinary Sporades user through every lookup that joins the user
table, on every engine. And the outstanding Reset code count must exclude expired
rows, since the ADR-0033 cap depends on that distinction.

Expect this to surface divergences beyond the ones already known. Any that
appear are fixed at the single shared definition rather than by overriding the
method on one engine's adapter, and the case that exposed the divergence stays in
the specification.

## Acceptance criteria

- [ ] The Session lifecycle is covered end to end, including deletion of every Session for one Sporades user.
- [ ] Provider identity lookup by provider and subject, and the legacy lookup by provider email, are covered.
- [ ] Email credential creation, existence, password update, and joined-user lookup are covered, with existence exercised for both a registered and an unregistered address.
- [ ] The Reset code lifecycle is covered, including issuing, lookup by selector, deletion for a user, and pruning.
- [ ] The outstanding Reset code count is asserted against a known non-zero quantity and proven to exclude expired rows.
- [ ] Every lookup that joins the user table is proven to return nothing for the reserved Privileged server role identity, on every engine.
- [ ] Any divergence found is fixed at the shared method definition, not by adding a per-engine override.
- [ ] Each case that exposed a divergence remains in the specification as a regression case.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/02-run-conformance-specification-against-every-adapter.md

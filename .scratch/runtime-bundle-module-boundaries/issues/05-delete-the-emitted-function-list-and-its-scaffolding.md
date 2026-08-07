Status: ready-for-agent

# Delete The Emitted Function List And Its Scaffolding

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

The module-graph bundle becomes the only bundle, and everything that existed to work
around the old one is deleted.

This is the contract half of the sequence, and it is the ticket where the value arrives.
Three pieces of machinery exist solely because a runtime function reached the bundle as
detached source text:

- **The emitted function list.** A global registry every runtime function was implicitly
  coupled to, where adding or removing one was a cross-cutting change with a
  production-only failure mode.
- **The bundle preamble's constant serialization.** Built to stop seventeen module
  constants — several of them security thresholds — from being restated in a second place
  that could silently drift. In a module graph a constant is imported, so there is no
  second place.
- **The free-binding guard.** Written to catch names that fail to travel into the bundle,
  because the language could not. A module graph makes that a build error, so the guard
  has nothing left to catch.

Deleting a guard is normally the wrong move, and it is worth being explicit about why it
is right here. The guard is not being weakened or bypassed: the class of defect it detects
stops being expressible. Confirm that rather than assume it — a deliberately broken
binding should fail the build before this ticket closes, which is the same property the
guard provided, enforced earlier and by the compiler.

Nothing can be deleted while a caller remains, so this ticket runs last and only after
every domain has moved.

## Acceptance criteria

- [ ] The module-graph bundle is the only server bundle built and shipped.
- [ ] The emitted function list is deleted, along with the dual-build scaffolding from the expand step.
- [ ] The preamble's constant serialization is deleted; constants reach the bundle as imports.
- [ ] The free-binding guard is deleted, and a deliberately missing binding is demonstrated to fail the build instead — the property is preserved, not dropped.
- [ ] The full suite passes and the generated-output checks pass.
- [ ] No behavioural change: a deployed Capsule enforces the same values and answers the same way as before the sequence began.
- [ ] The ADRs that recorded the old mechanism's constraints are updated or superseded, so no ADR is left describing machinery that no longer exists.

## Blocked by

- .scratch/runtime-bundle-module-boundaries/issues/04-migrate-the-remaining-runtime-domains-out-of-the-monolith.md

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

## Comments

### Dead code the migration surfaced — one deleted, three still standing

The nine batches of ticket 04 exposed several functions that reached a deployed Capsule
*only* by being entries in `SERVER_RUNTIME_SOURCE_FUNCTIONS`, with no caller anywhere. They
belong to this ticket rather than to a migration batch: a batch that moves a domain must not
also change what ships, so each was reported and left standing.

**`mailJsonSize` — deleted.** Batch 2 moved the mail domain and had to give this function an
`export` it did not deserve, purely to stop esbuild tree-shaking it out of the carried block
so the shipped artifact stayed byte-comparable across a no-behaviour-change refactor. Now
removed along with that export. Confirmed dead first by four checks, since a name-based
lookup is the failure mode this sequence kept hitting: no reference in `src/`, `test/`,
`scripts/`, `docs/` or `.scratch/` beyond its own declaration and header comment; not an
entry in the emitted list (batch 2 removed it when the domain moved); no string-literal
lookup; not named in any probe or census list. The generated bundle carried it in **4
occurrences before and 0 after**, which is the check that matters — the `export` and the
artifact were coupled, so only removing both takes it out of every deployed Capsule. Full
suite green at 1,455 tests, count unchanged.

**Still standing, all in `src/auth-runtime.ts`, all genuinely unreferenced:**

- `refreshSession` — declared, zero references anywhere.
- `rotateSession` and `moveSessionToUser` — batch 5 established that nothing in the
  repository names them at all, and made them private on that basis. Being private and
  unreferenced, esbuild already drops them from the carried block, so they no longer reach a
  Capsule's top-level scope — but the source declarations remain.

**Corrections to the inventory earlier batches reported**, which is stale in two places:

- `postgresPlaceholders` was on batch 2's dead list but had already been deleted by
  ticket 01. Nothing to do.
- `readJsonRequest` is **not** dead — it has live CLI callers. Batch 2's first report said
  "used only by the CLI, never by the deployed bundle" in a way that read as deletable;
  batch 3's reviewer corrected it. It must be **removed from the emitted list, not deleted.**

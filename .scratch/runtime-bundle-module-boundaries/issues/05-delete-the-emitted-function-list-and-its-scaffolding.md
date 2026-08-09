Status: done

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

- [x] The module-graph bundle is the only server bundle built and shipped.
- [x] The emitted function list is deleted, along with the dual-build scaffolding from the expand step.
- [x] The preamble's constant serialization is deleted; constants reach the bundle as imports.
- [x] The free-binding guard is deleted, and a deliberately missing binding is demonstrated to fail the build instead — the property is preserved, not dropped.
- [x] The full suite passes and the generated-output checks pass.
- [x] No behavioural change: a deployed Capsule enforces the same values and answers the same way as before the sequence began.
- [x] The ADRs that recorded the old mechanism's constraints are updated or superseded, so no ADR is left describing machinery that no longer exists.

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
suite green, count unchanged. (That run was reported as 1,455 tests; `npm test` on this
branch answers 1,392, and the larger figure came from a differently scoped invocation.
Measured both ways before and after, and the count was unchanged either way.)

**The other three are deleted too, as of this ticket.** All were in `src/auth-runtime.ts`
and all were genuinely unreferenced:

- `refreshSession` — declared, zero references anywhere.
- `rotateSession` and `moveSessionToUser` — batch 5 established that nothing in the
  repository named them at all, and made them private on that basis. Being private and
  unreferenced, esbuild already dropped them from the carried block, so they had already
  stopped reaching a Capsule's top-level scope; the source declarations are now gone as
  well.

**Corrections to the inventory earlier batches reported**, which is stale in two places:

- `postgresPlaceholders` was on batch 2's dead list but had already been deleted by
  ticket 01. Nothing to do.
- `readJsonRequest` is **not** dead — it has live CLI callers. Batch 2's first report said
  "used only by the CLI, never by the deployed bundle" in a way that read as deletable;
  batch 3's reviewer corrected it. It had to be **removed from the emitted list, not
  deleted** — which the deletion of the whole list settled, leaving the function and its CLI
  callers untouched.

### What was deleted, and what it cost

Five commits, ~5,600 lines net removed.

`src/templates/server-bundle-template.ts` is gone entirely — all 2,166 lines. Every
one of its exports was emitted-list machinery: the carrier, the constant
serialization, `MIGRATED_RUNTIME_MODULES`, and roughly 1,100 lines of skew-probe
fixtures. `SERVER_RUNTIME_SOURCE_FUNCTIONS` is gone (537 entries at its largest, 107
at the end), as is `test/server-bundle-free-bindings.test.js` and the
`SPORADES_SERVER_BUNDLE_MODULE_GRAPH` switch. Seven functions exported only for the
skew probe are private again.

**The criterion that needed real work was the fourth one**, and only because running
the sabotage rather than reasoning about it found a gap. Three deliberately broken
bindings: a misspelled private helper (TS2552, build exits 2), an import of a name a
module does not export (TS2305, exit 2), and `document.title` inside a live runtime
function — which **built clean, exit 0**. `tsconfig.json` compiles with
`lib: ["ES2022", "DOM"]` because `client.ts` is browser code, so a runtime module can
reach a browser global and ship it into a container that has no DOM. The
free-binding guard covered that deliberately and failed on the planted case, so
deleting it alone would have dropped real coverage. `tsconfig.runtime.json` restores
it as a compile error, rooted at `server-bundle-entry.ts` with an empty `include` so
the checked set *is* the graph esbuild carries — no second list to keep in step.

**A check was genuinely lost.** The carrier compared each migrated module's `dist/`
copy against the copy inlined into `bin/sporades.js`, on every build. The module
graph still reads `dist/` and a released CLI still runs from `bin/`, so that skew is
still expressible; what remains is only that esbuild cannot bundle a `dist/` file
that will not parse. Rebuilding the probe apparatus against one bundle was judged
not worth ~1,100 lines. Recorded in ADR-0041 rather than left as an absence.

### The census hole is closed

Batch 9 reported that the walker guards' floors and sentinels are consulted only for
*listed* modules, so deleting an entry removed a module from the census silently.
Batches 1–8 each ran that counterfactual and watched both guards pass; batch 9's
failed by luck. The census list is now checked against the bundle's own module graph,
walked from `server-bundle-entry.js`, with two named exclusions — and verified by the
same counterfactual, which now fails. The monolith joined the census as an ordinary
entry read off disk, which is strictly stronger than the list it replaces:
`fn.toString()` could only show the census a function somebody had registered.

The OAuth name census needed the same attention for a different reason: it read the
list plus `Object.keys`, and its assertions are negative, so losing the list would
have made it pass vacuously for exactly the reason a per-provider function would be
added — privately. It reads declarations out of compiled text now.

### Two decisions taken deliberately

**Batch 9's flag — that two groups left in the monolith are domains rather than
composition (the 29-function Capsule source parser and the 12-function platform log)
— is answered "not here".** Ticket 05 is a deletion. Splitting a domain out is a
migration, and mixing one into the contract step is what would make a regression
indistinguishable from the deletion going wrong. The monolith is 3,889 lines across
107 declarations; both groups are still precisely identified for whoever picks them
up.

**Four pre-existing status-code bugs were found and left alone.** Converting the
pairwise comparisons into assertions forced claims to be written down that the old
form structurally could not make — a step failing in *both* bundles compared equal
and passed. That turned up `{not json` with a JSON content-type answering 500 rather
than 400, and all three OAuth callback rejections doing the same, so client errors
are reported as the Capsule's fault. Pinned by name in
`test/server-bundle-module-graph.test.js` so the set cannot grow quietly, and so
whoever fixes one has to come here and delete its name.

### Verification

Full suite `npm test`: **1,387 tests, 1,331 pass, 0 fail, 56 skipped, exit 0**, with
`check-generated-bin.mjs` passing via `pretest`. The baseline on this branch before
ticket 05 was 1,392 / 1,336 / 0 / 56, and the difference accounts exactly: −4 for the
deleted free-binding guard file, −2 for the two carrier tests, +1 for the new census
coverage test.

Three tests are now stronger than what they replaced, because a comparison between
two artifacts can only ever report that they agreed, never that either was right:

- Every runtime constant is compared against **its module's own declaration**, not
  against the other bundle. Several are security thresholds, which is the claim this
  ticket actually had to make.
- The bundled inspection gate is compared against **the module under `dist/`**.
- The census reads **declarations**, so privacy is not a way out of it.

Status: ready-for-agent

# Migrate The Remaining Runtime Domains Out Of The Monolith

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

The rest of the runtime leaves `src/server-runtime-source.ts` and becomes modules, one
domain per batch, until nothing but composition and wiring remains behind.

Ticket 03 moved the first region and established the mechanics, so this is no longer a
sizing question. It is a sequence of eight batches, listed below in the order they should
land. Each batch is one commit and one review cycle: it moves one domain, keeps both
bundles building, and lands green on its own.

At the time of writing the module holds **13,738 lines** and **514 entries** in
`SERVER_RUNTIME_SOURCE_FUNCTIONS`, against 518 module-scope function declarations and 17
SCREAMING_CASE constants.

## The batches, in order

Counts are indicative — they come from function-name matching, not from a dependency
graph. **Establish the real set for your batch before moving anything.** Ticket 01's
ticket named two duplicated walkers and there were five; ticket 03's region turned out to
own a tokenizer the log-index guard also used. The count below tells you the rough size,
not the boundary.

Leaf domains go first and the core goes last, because everything calls into the adapters
and the HTTP layer and almost nothing calls out of them.

1. **Log-index guard** (~4 functions). Finishes what ticket 03 started:
   `targetsInternalLogIndexTable`, `readSqlTableReference`, `readSqlIdentifier`,
   `isInternalLogIndexMetadataRow` stayed behind and now import `skipSqlTrivia` and
   `readSqlQuotedIdentifier` across a module boundary. Smallest possible batch, and it
   resolves an existing cross-module seam rather than creating one.
2. **Mail** (~43). `src/mail-config.ts` already exists, so part of this domain is outside
   already and the join is a known quantity.
3. **Auth** (~16 by name, expect more — sessions, OAuth, password reset and the throttles
   travel with it). Several of the 17 preamble constants are this domain's security
   thresholds; they move with it.
4. **Jobs and schedules** (~26 + ~26). One batch, not two: they share the queue and
   occurrence machinery, and splitting them would put that shared surface on a boundary.
5. **File and object storage** (~54). Includes the S3 path and the upload lifecycle.
6. **ACL and privileged audit** (~61). Carries `ACL_HELPER_STATE`, whose Symbol identity
   was analysed at length in issue 16 — read that before moving it.
7. **HTTP and security policy** (~17). CORS, CSP and the request/response plumbing.
8. **Database adapters and dialect** (~55). Last, deliberately. Every other domain reaches
   the engines through it, so it has the most inbound edges and moving it earlier would
   put a boundary under every other batch.

## Mechanics established by ticket 03

Use these rather than rediscovering them. All are recorded in ADR-0041.

- **`export * from "./<module>.js"` is the re-export bridge.** It keeps a moved region's
  names reachable to the still-monolithic runtime and, critically, keeps ticket 02's
  constants probe deriving over them.
- **The emitted-list carrier depends on whether the region imports anything.** Ticket 03's
  module imports nothing, so it travels as a single `transformSync` IIFE. A region with
  imports of its own needs `build` instead — `transformSync` emits `require(...)` and the
  Capsule dies at boot with "Cannot determine intended module format".
- **Destructured names must be derived, never restated.** A hand-written list declares an
  `undefined` binding that the free-binding guard resolves as cleanly as a correct one.
- **Guards that read `SERVER_RUNTIME_SOURCE_FUNCTIONS` go blind on every batch**, because
  their subject set shrinks as functions leave. `walkerGuardSubjects()` in
  `test/database-adapter-engine-seam.test.js` is the pattern: union the emitted list with
  the functions each migrated module declares. It currently hard-codes
  `dist/inspection-sql.js` — **batch 1 should generalise it to a list of migrated
  modules**, so batches 2–8 only add an entry.
- **Expect couplings the single file was hiding.** Grep for callers before drawing a
  boundary. Ticket 03 found the log-index guard lexing SQL with the inspection gate's
  tokenizer, which was invisible while both lived in one file.

## Per-batch acceptance criteria

Every batch must satisfy all of these on its own:

- [ ] The domain lives in its own module, imported by the module-graph bundle and carried into the emitted-list bundle by the appropriate carrier for whether it imports anything.
- [ ] The real set of functions and constants belonging to the domain was established by inspection before the move, and is reported — not assumed from the counts above.
- [ ] Any constant the domain owns travels with it, and the preamble still serializes exactly what the bundle needs.
- [ ] A deliberately missing or misspelled binding inside the moved module fails the build rather than reaching a deployed Capsule as a `ReferenceError`.
- [ ] Every guard that reads the emitted list has had its subject set extended to cover the new module, demonstrated by planting a violation in the moved module and watching the guard fail.
- [ ] Both bundles build and answer identically across the domain's surface, demonstrated by sabotage rather than asserted from a green run.
- [ ] The emitted-list bundle is still the default and still ships; `SPORADES_SERVER_BUNDLE_MODULE_GRAPH` semantics are unchanged.
- [ ] The full suite is green, with no regression against the batch's own base.

## Sequencing

Run the batches as a linear chain, not in parallel. Every batch deletes from the same
file and edits the same emitted list, so concurrent batches conflict continuously — the
pattern that has already cost this effort real time. A shared integration branch would
avoid the conflicts but defer green to the end, which is the opposite of what makes a
batch sequence safe.

## When this is done

`src/server-runtime-source.ts` retains composition and wiring only. Nothing is deleted
yet — the emitted list, the preamble serialization and the free-binding guard all still
exist and still ship. Removing them is ticket 05, which is blocked by this one.

## Blocked by

- .scratch/runtime-bundle-module-boundaries/issues/03-move-the-read-only-inspection-validator-into-a-module.md

Status: ready-for-agent

# Migrate The Remaining Runtime Domains Out Of The Monolith

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

The rest of the runtime leaves `src/server-runtime-source.ts` and becomes modules, one
domain per batch, until nothing but composition and wiring remains behind.

Ticket 03 moved the first region and established the mechanics, so this is no longer a
sizing question. It is a sequence of nine batches, listed below in the order they should
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
5. **User preferences** (6 functions), **and the six auth stragglers it unblocks.** Small,
   and deliberately early rather than last. `migrateAnonymousPreferences` is the only thing
   keeping `rotateSessionOnAdapter` and `moveSessionToUserOnAdapter` — and through them
   `signInWithEmail`, `signUpWithEmail`, `linkProviderIdentity`, `rotateSession` and
   `moveSessionToUser` — inside the monolith after batch 3 moved the rest of auth. Running
   it here lets auth finish instead of staying half-migrated through four more batches,
   each of which would otherwise work around the same blocked functions. It carries those
   six into `auth-runtime.ts` as a rider, so no tenth pass is needed.
6. **File and object storage** (~54). Includes the S3 path and the upload lifecycle.
7. **ACL and privileged audit** (~61). Carries `ACL_HELPER_STATE`, whose Symbol identity
   was analysed at length in issue 16 — read that before moving it.
8. **HTTP and security policy** (~17). CORS, CSP and the request/response plumbing.
9. **Database adapters and dialect** (~55). Last, deliberately. Every other domain reaches
   the engines through it, so it has the most inbound edges and moving it earlier would
   put a boundary under every other batch.

Batch 5 was added after batch 3 reported that user preferences sat on no batch's list. It
is its own batch rather than a rider on storage, ACL or HTTP because folding an unrelated
six-function domain into one of those would put a second boundary decision inside a review
that already has one.

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

## No new behavioural tests — and why that is not the same as no verification

This is a refactor. Behaviour must not change, so the existing suite is the oracle and
**no batch should write new behavioural tests.** Fresh tests written against a moved
domain would test its new shape rather than its preserved behaviour, which is worse than
writing none.

Two existing mechanisms still have to be exercised and maintained, because the suite
alone cannot see the defect this work can cause. Neither is a new test.

**The suite does not test the artifact that ships.** Tests import from `dist/`, where the
real declarations live. A name that fails to reach the emitted bundle is a
`ReferenceError` in a deployed Capsule while every test stays green — four production
`ReferenceError`s were caught this way, and issue 16 existed because constant values were
restated in the bundle and no test could see the copy drift. So each batch runs
`test/server-bundle-free-bindings.test.js` and ticket 02's two-bundle equivalence harness,
and demonstrates them failing under sabotage rather than reporting that they passed.

**Guards that read `SERVER_RUNTIME_SOURCE_FUNCTIONS` decay silently as functions leave
it.** Their subject set shrinks with every batch; they keep passing while covering less.
Extending that subject set is maintenance of an existing guard, not a new test — but
skipping it is the single most likely way this sequence ships a regression, because
nothing goes red. That is why batch 1 generalises `walkerGuardSubjects()` and every later
batch adds its module to the list.

## Running the suite

**Run the full suite at the end of every batch, not once at the end of the sequence.** It
takes about seven minutes, so the whole sequence costs under an hour of test time. Running
it once at the end means a red at batch 8 has to be bisected across eight refactors of a
13,738-line file.

The database-focused files are 12 of 53. They are the right *focused* check for batch 8,
and the wrong check for batches 2 through 7 — mail, auth, jobs and schedules, storage, ACL
and HTTP are barely touched by them. Use the focused files for the fast inner loop while
working; use the full suite as the gate before the batch is done.

## Known flaky tests — do not misattribute these to your batch

- **`test/dev.test.js` "a scaffolded photo library stores uploads, public gallery rows,
  and Google-owned private library rows"** races a once-a-minute scheduled job. The
  scaffolded capsule schedules `timestampPhotoNames` on `* * * * *`
  (`src/templates/scaffold-template.ts`), and that job rewrites every photo's `title` and
  `fileName` with an `HH:MM ` prefix. The test asserts the raw title, so if the test window
  crosses a minute boundary the assertion fails with e.g. `'08:11 Shoreline'` against
  `'Shoreline'`. Diagnosed during batch 2, which cannot be causal — its diff touches
  neither the scaffold nor the scheduler. Re-run the test standalone before reporting it,
  and file it separately rather than fixing it inside a migration batch.
- **`test/dev.test.js` "React Vite redacts symlink aliases and canonical project roots"**
  fails when the checkout path resolves through a symlink. Passes from the main worktree.

## Open items raised by the batches, not yet actioned

- **~~`engines` understates the Node floor.~~ Resolved.** `package.json` now declares
  `"node": ">=22.3.0"`, matching the floor `process.getBuiltinModule` (ADR-0042) actually
  requires. Previously `">=22"`, which gave a user on 22.0–22.2 no warning and a runtime
  crash.
- **~~User preferences are on no batch's list.~~ Resolved** — they are batch 5, carrying the
  six auth stragglers they unblock.
- **Nothing parses the built bundle for duplicate top-level declarations.** Batch 3 found
  `commandError` declared twice — an emitted-list entry *and* a carried declaration, which
  is a load-time `SyntaxError` in a deployed Capsule — and no test caught it, because the
  free-binding guard resolves names rather than counting declarations. Worth a permanent
  check.

## Per-batch acceptance criteria

Every batch must satisfy all of these on its own:

- [ ] The domain lives in its own module, imported by the module-graph bundle and carried into the emitted-list bundle by the appropriate carrier for whether it imports anything.
- [ ] The real set of functions and constants belonging to the domain was established by inspection before the move, and is reported — not assumed from the counts above.
- [ ] Any constant the domain owns travels with it, and the preamble still serializes exactly what the bundle needs.
- [ ] A deliberately missing or misspelled binding inside the moved module fails the build rather than reaching a deployed Capsule as a `ReferenceError`.
- [ ] Every guard that reads the emitted list has had its subject set extended to cover the new module, demonstrated by planting a violation in the moved module and watching the guard fail.
- [ ] Both bundles build and answer identically across the domain's surface, demonstrated by sabotage rather than asserted from a green run.
- [ ] The emitted-list bundle is still the default and still ships; `SPORADES_SERVER_BUNDLE_MODULE_GRAPH` semantics are unchanged.
- [ ] No new behavioural test was written; the existing suite is the oracle.
- [ ] The full suite is green at the end of the batch, with no regression against the batch's own base.

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

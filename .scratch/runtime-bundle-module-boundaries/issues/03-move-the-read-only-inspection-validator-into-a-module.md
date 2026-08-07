Status: done

# Move The Read-Only Inspection Validator Into A Module

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

The read-only inspection validator — everything `sporades db query` uses to decide whether
a statement is safe to run — leaves the runtime monolith and becomes a module with
ordinary imports and private helpers, reaching the deployed bundle through the module
graph rather than through a list of stringified functions.

This is the first migrate batch, and the region is chosen deliberately. It is the smallest
coherent piece of the runtime, and it is the one that has cost the most: five rounds of
fixes and four independent reviews, every one finding a real defect of the same family,
because the constraint against factoring forced its lexing logic to exist in more than one
copy. It is the best evidence that the pattern works, and the place where working proves
the most.

The point is not relocation. It is that inside a module the validator can have private
helpers that do not have to be registered anywhere to survive, so the duplication that
caused those defects stops being the price of shipping. Extracting a helper should become
an ordinary edit with a compile-time failure mode.

Both bundles still build, so this batch is verifiable on its own: the module-graph bundle
carries the validator through imports while the emitted-list bundle carries it as text,
and both must answer identically.

Land the tokenizer work first if it has not already landed, so this moves one tokenizer
rather than two. It is not a hard gate — moving two is no harder than moving one — but the
sequence is cheaper and leaves less to unpick.

## Acceptance criteria

- [ ] The read-only inspection validator and its lexing live in their own module, imported rather than stringified.
- [ ] The module has at least one private helper that is not registered in any emitted list, demonstrating that factoring is now free.
- [ ] A deliberately missing or misspelled binding inside the module fails the build, rather than reaching a deployed Capsule as a `ReferenceError`.
- [ ] Every payload class already known to this work stays refused, demonstrated against a live canary on SQLite, libSQL and Postgres.
- [ ] The module-graph bundle and the emitted-list bundle answer identically for the whole inspection surface.
- [ ] No realistic query is newly refused, measured against the pre-work baseline.
- [ ] The emitted-list path still builds and still ships; nothing else has moved.

## Blocked by

- .scratch/runtime-bundle-module-boundaries/issues/02-build-the-server-bundle-from-a-module-graph.md

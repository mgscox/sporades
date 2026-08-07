# A migrated runtime region travels as a module, not as registered functions

The read-only inspection validator is the first region of `server-runtime-source.ts`
to become its own module. What it cost to move is not the relocation — that is a
`git mv` and a set of imports — but the answer to a question the expand–contract
sequence has to answer once and then reuse: **while both bundlers exist, how does
a region that has left the monolith reach the bundle that still ships?**

There is a precedent that looks like the answer and is not. `validateMailConfig`
lives in `mail-config.ts` and is *also* an entry in
`SERVER_RUNTIME_SOURCE_FUNCTIONS`, so it is imported by the module-graph bundle
and stringified by the emitted-list one. That works, and for a leaf function with
no helpers it is the cheapest thing that works. It does not work here, and the
reason it does not is the reason this region was chosen to move first.

## Why registering the moved functions would have moved nothing

Under the emitted list, a runtime function reaches the bundle as its own source
text. Nothing it closes over travels with it, so a helper it calls must itself be
registered or it is a `ReferenceError` in a deployed Capsule — legal JavaScript,
a clean build, and invisible to every test, because tests import from `dist/`
where the name resolves. Four bindings shipped that way before a guard was
written for the class.

The consequence is that **the cheapest correct edit in this region has always been
to write the logic out again**, and ADR-0038 is the record of what that cost: five
copies of one set of comment and quoting rules, five rounds of fixes, four
independent reviews, every one finding a real defect of the same family, and one
security-critical asymmetry destroyed by an edit that looked obviously correct.

Moving the functions into a module while leaving them registered would have left
that intact. Every factoring opportunity in this region is between functions that
the emitted list carries — `sqlContentFingerprint` and `sqlWithoutTrailingTerminator`
share a literal-or-comment test, and six walks share a scan skeleton — so a helper
extracted from any of them is called from emitted source text and has to be
registered. The file would have a new path and the same rule about what may be
written in it. That is relocation, and relocation was explicitly not the point.

## The decision

**A migrated region is carried into the emitted-list bundle as the module's own
compiled text, as one block, rather than as `fn.toString()` over a list of its
functions.** `createServerBundleSource` reads `dist/inspection-sql.js`, converts
it to an IIFE with esbuild's `transformSync`, and destructures the exports it
needs at the bundle's top level. The module-graph bundle keeps importing it, and
esbuild resolves the names.

Two properties follow, and they are what the ticket asked for:

- **A private helper needs no registration.** It is in the file, so it is in the
  block. `nestingBlockCommentEnd` and `opensQuotedRun` are the first two, and
  neither is exported from anything or named in any list.
- **A name that fails to travel is a compile error.** There is no list to be
  omitted from, so the failure mode that produced four shipped `ReferenceError`s
  in this region cannot recur in it. `npm run build` exits 2 with `TS2304` for a
  missing binding and `TS2552` for a misspelled one; both were demonstrated
  against this module rather than asserted.

An IIFE rather than concatenation with the `export` keywords stripped, and the
reason is privacy rather than safety. An earlier version of this section said
concatenation would risk "a silently shadowed function declaration rather than an
error", and execution says otherwise: the generated bundle is unconditionally an
ES module — it imports `node:crypto` and uses top-level `await` — and a duplicate
top-level declaration there is a load-time `SyntaxError`.

    duplicate function declaration  -> status 1, SyntaxError: Identifier
                                       'skipSqlTrivia' has already been declared
    duplicate preamble const        -> status 1, SyntaxError: Identifier
                                       'PASSWORD_RESET_MIN_TTL_MS' has already been declared
    the same written as var         -> status 0, boots

Only `var` shadows silently, and `export function foo` strips to `function foo`,
so a collision under concatenation would be loud. That is the same mechanism that
makes a duplicate entry in the emitted list loud, which is why none is left there
and why `server-runtime-source.ts` says so at the point the entries were removed.

What concatenation would actually cost is the thing this change exists for: every
one of the module's private helpers would land at the bundle's top level, reachable
from five hundred other runtime functions, so "private" would stop meaning anything
at exactly the point it started to matter. Inside the IIFE it means what it says.
Not stripping `export` keywords out of generated JavaScript by hand is the second
reason and the smaller one.

The destructured names are **derived from the module's live exports**, not written
out beside it. A hand-kept list here would have the failure mode the constant
preamble had before it was serialized from the runtime source: a name spelled
wrong declares a binding that is `undefined` at runtime, and the free-binding
guard resolves it exactly as cleanly as a correct one. Derived, a name that is not
exported is never declared, so the guard sees the consumer's reference as
unresolved and fails the build. The guard's coverage of this region is preserved
rather than traded away.

## What this costs, stated rather than left to be found

**The emitted-list builder now reads a file, and that splits the module in two.**
It read none before — concatenating source text resolves nothing, which is the
property ADR-0040 records as the reason the `toString()` mechanism satisfied
self-containment by construction. `createServerBundleModuleSource` already had to
locate its own entry, and the walk to the package root that ADR-0040 explains is
now shared (`resolveSporadesPackageRoot`) rather than written twice.

The split is the part that is easy to miss. While the CLI ships as
`bin/sporades.js`, esbuild has inlined `inspection-sql` into that bundle — so the
names come from the copy inside `bin/` while the carried text comes from
`dist/inspection-sql.js` on disk. Running from `dist/` there is one copy and the
question does not arise. Running from `bin/`, a tree whose `dist/` and `bin/` came
from different builds would put the `dist/` gate inside a deployed Capsule while
every other runtime function in that same Capsule came from `bin/`.

**Nothing in `scripts/` compares them.** `check-generated-bin.mjs` checks the
shebang, the generated-file header and the absence of `../src/` imports; it has no
mtime, hash or freshness comparison, and an earlier version of this section and of
the comment in `server-bundle-template.ts` both claimed a check it does not
perform. The measured consequence was that a `dist/inspection-sql.js` whose
validator had been replaced by one admitting everything built cleanly and shipped
verbatim.

So the builder compares the two copies itself, and the comparison is in two parts
because the same names are not enough:

- **The export surface**, taken from the carried block after evaluating it, must
  equal the running module's. This also makes "declared in the block, absent from
  the destructuring" unreachable, because the destructured names now come from the
  block rather than from the import.
- **The answers**, over a fixed probe of statements the gate refuses and admits,
  drawn from the shapes ADR-0038 records as having defeated it. A carried copy
  whose validator body differed would keep every export and still fail here.

Four skews were executed rather than reasoned about — an allow-everything
validator, a tokenizer whose line comment stops ending at a carriage return, a
missing export, and a file truncated mid-function. Each is now a build error with
an actionable hint; the first two were silent before.

**This is a probe, not a proof, and the residual is stated rather than left to be
found: two copies that agree on the export surface and on every statement in that
probe still ship, however else they differ.** The probe is guarded in turn — a test
asserts it both refuses and admits at least five statements, because a probe the
gate admits in full could not see an allow-everything validator at all. The whole
question disappears with the emitted list, which is when the disk read goes away.

**The emitted-list builder now spawns esbuild.** `transformSync` runs the esbuild
binary out of process. Measured rather than assumed: the steady state is 1.3 ms per
call, because esbuild's synchronous API reuses the process it started, and the
first call in a process pays for the spawn — 52 ms on the machine this was written
on and 21.8 ms on a reviewer's, so treat the shape as the finding and not the
figure. That buys keeping `createServerBundleSource` synchronous,
which every caller and three test files expect. The alternative — making it
`async` and using the esbuild service the bundle pipeline has already started for
the Capsule module — is better on both counts and was not taken here, because
changing the shipping builder's signature is a wider change than this batch should
make and the whole carrier disappears when the emitted list does.

**The bundle's self-containment is unchanged.** `transformSync` resolves nothing:
it is a format conversion of one already-compiled file, and the module imports
nothing. The output is still a program whose only external imports are Node
builtins, which the module-graph builder proves from esbuild's metafile and the
free-binding guard proves by resolving every identifier in the emitted text.

**The walker census had to stop reading a list.** The census in
`test/database-adapter-engine-seam.test.js` flagged emitted runtime functions
whose source names comment or quote delimiters, and asserted the detected set
*equals* a written census. Moving the gate out of `SERVER_RUNTIME_SOURCE_FUNCTIONS`
made it invisible there, so the census would have gone quiet about the one
tokenizer while continuing to report success — the exact shape of failure ADR-0038
spends its methodology section on. It now reads the union of the emitted list and
**every function `inspection-sql` declares, parsed out of the module's compiled
source text**. Reading the module's *exports* would have been the easy version and
the wrong one: privacy would have become a way to leave the census, at the moment
privacy became possible. `nestingBlockCommentEnd` is a private helper and is a
census entry, and a planted private walker in that module was confirmed to fail
the census rather than reasoned about.

**Reading source text opened a gap in the same change that closed one, and the two
are the same fact.** A collector that saw only `FunctionDeclaration` nodes could
not see `const foo = (…) => {…}`, and a second SQL walker written that way passed
both walker guards and reached both bundles. That form was not previously
reachable in this region: under the emitted list a helper travelled as
`fn.toString()`, which for an arrow yields an expression and no top-level
declaration, so `inspection-sql`'s predecessors were forced into `function`
declarations. Carrying the module whole made the form legal here for the first
time, which is why closing it belongs to the same change. The collector now takes
variable statements whose initializer is an arrow or function expression as well,
and its own coverage is settled on a fixture rather than inferred from how many
entries it found — a collector that had stopped seeing one form still returns
plenty of entries, which is exactly what that failure looks like from outside.
Known misses are named in the test rather than left implicit: a walker declared as
a class method, or assigned to a property of an exported object, is not collected
in its own right, while one nested inside another declaration is covered through
its enclosing text.

## What is not decided here

This says nothing about *which* regions move or in what order, and nothing about
what happens when the emitted list is deleted. At that point the block carrier and
the reading of `dist/` go with it, because the module-graph bundle imports the
module directly and needs neither.

It also does not claim the mechanism generalizes untested to every region. It is
proven for one module that imports nothing, and the boundary of that has been
executed: give `transformSync` a module with an import and it emits a `require(…)`
into the IIFE, and the Capsule dies at boot with "Cannot determine intended module
format". Loud rather than silent, but a region with imports of its own needs
`build` rather than `transformSync`. A region whose functions are called
from the still-monolithic runtime will keep needing exports for those names — which
is what `skipSqlTrivia` and `readSqlQuotedIdentifier` are here, because the
internal log-index table guard lexes SQL with this gate's tokenizer and did not
move. That coupling was invisible while both lived in one file, and it is the kind
of thing the next batch should expect to find rather than discover.

## Relationship to existing decisions

Extends ADR-0040, which established that self-containment is a property of the
output rather than of `toString()`, and that building from a graph means locating
files. ADR-0038 is unchanged in substance: the gate's rules, its refusals and its
tokenizer are the same, measured over 766,065 candidates against the pre-work base
with zero differences in verdict, refusal reason, terminator strip or any of the
seven internal walks. What ADR-0038 records as *forced* — helpers written inline
because a helper had to travel — is no longer forced for this file, and the two
places that said so have been corrected rather than left to mislead the next
reader.

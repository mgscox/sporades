# A migrated runtime region travels as a module, not as registered functions

The read-only inspection validator is the first region of `server-runtime-source.ts`
to become its own module. What it cost to move is not the relocation — that is a
`git mv` and a set of imports — but the answer to a question the expand–contract
sequence has to answer once and then reuse: **while both bundlers exist, how does
a region that has left the monolith reach the bundle that still ships?**

There is a precedent that looks like the answer and is not. `validateMailConfig`
lived in `mail-config.ts` and was *also* an entry in
`SERVER_RUNTIME_SOURCE_FUNCTIONS`, so it was imported by the module-graph bundle
and stringified by the emitted-list one. That works, and for a leaf function with
no helpers it is the cheapest thing that works. It does not work here, and the
reason it does not is the reason this region was chosen to move first.

(Past tense because batch 2 ended that arrangement: `mail-config.js` is carried
module text now, alongside the rest of the mail domain, and the emitted-list entry
had to go with it or the bundle would declare `validateMailConfig` twice. The
description above is kept because it is what made the contrast legible, not
because it still describes the tree.)

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
functions.** `createServerBundleSource` builds the modules listed in
`MIGRATED_RUNTIME_MODULES` out of `dist/` into one IIFE with esbuild's
`buildSync`, and destructures their exports at the bundle's top level. The
module-graph bundle keeps importing them, and esbuild resolves the names.

The first version of this read one file and converted it with `transformSync`,
because the first migrated region imported nothing. The second one did, and the
section "What is not decided here" below had already named what that costs; what
it did not anticipate is that *one block for all of them* rather than one block
each is also forced, and by a different argument. See "Why the modules are
bundled together" below.

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
`bin/sporades.js`, esbuild has inlined every migrated module into that bundle — so
the names come from the copies inside `bin/` while the carried text is built from
`dist/` on disk. Running from `dist/` there is one copy and the question does not
arise. Running from `bin/`, a tree whose `dist/` and `bin/` came from different
builds would put the `dist/` gate inside a deployed Capsule while every other
runtime function in that same Capsule came from `bin/`.

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
  equal the union of the running modules'. This also makes "declared in the block,
  absent from the destructuring" unreachable, because the destructured names now
  come from the block rather than from the import.
- **The answers**, over a fixed probe drawn from the shapes ADR-0038 records as
  having defeated the gate. A carried copy whose validator body differed would keep
  every export and still fail here. The probe grew a second half when the log-index
  guard arrived, because that module answers about *rows* as well as SQL, and a
  copy that had lost its row filter agrees with the running one about every
  statement.

Seven skews were executed rather than reasoned about — an allow-everything
validator, a tokenizer whose line comment stops ending at a carriage return, a
missing export, a file truncated mid-function, a log-index guard that no longer
recognises the table it conceals, one whose row filter stopped flagging metadata
rows, and a gate that stopped exporting the tokenizer the guard imports. Each is a
build error with an actionable hint; the first two were silent before, and the
last is only reachable at all because the carrier resolves the graph.

**This is a probe, not a proof, and the residual is stated rather than left to be
found: two copies that agree on the export surface and on every statement in that
probe still ship, however else they differ.** The probe is guarded in turn — a test
asserts it both refuses and admits at least five statements, because a probe the
gate admits in full could not see an allow-everything validator at all, and asserts
the same in both directions for each of the log-index guard's two limbs. The whole
question disappears with the emitted list, which is when the disk read goes away.

**The emitted-list builder now spawns esbuild.** `buildSync` runs the esbuild
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

`buildSync` costs one capability the first version had: **it accepts no plugins**,
so there is no way to hand esbuild an in-memory module graph. The skew seam
therefore takes a *directory* rather than a string of module text, and the test
that drives it writes a scratch copy of `dist/`. That is the more faithful seam
anyway — a skewed module is now resolved by the same import the shipping build
resolves, which is what makes "a gate that stopped exporting the tokenizer the
guard imports" a case that can be executed at all.

**Why the modules are bundled together.** One block for every migrated module,
not one block each, and the reason is not tidiness. Bundling each module
separately inlines its dependencies into its own block, so `inspection-sql` would
appear once per module that imports it. Two copies inside the shipped artifact
cannot drift — same file, same build — but ADR-0038's whole subject is that the
duplication *itself* is what generates the defects, and an artifact that
contradicts it teaches the next reader the wrong thing. Asserted rather than
described: the emitted-list bundle is checked to contain exactly one
`function skipSqlQuotedOrCommented(`.

**The bundle's self-containment is now a property that has to be checked rather
than one that holds by construction.** `transformSync` resolved nothing, so the
first version of this carrier could not import anything by accident. `buildSync`
with `bundle: true` resolves within the migrated set and marks everything else
external — and `format: "iife"` writes an external as `require(…)`, which in this
ES-module bundle is not a slow path but a Capsule that does not boot. So the
carrier reads esbuild's metafile and refuses external imports, the way
`createServerBundleModuleSource` does (ADR-0040).

**That refusal was "any external at all" for two batches, and the mail domain is
where it turned out to be one kind too broad.** The claim it rested on — "a
builtin is no better than a package here" — is true of a *static* import and not
of a dynamic one, and the difference is in what esbuild emits rather than in what
the image can supply:

    import { randomUUID } from "node:crypto"  -> __require("node:crypto"), and the
                                                 bundle throws `Dynamic require of
                                                 "node:crypto" is not supported` on
                                                 its first line
    await import("node:tls")                  -> emitted verbatim, resolves in the
                                                 container exactly as the bundle's
                                                 own top-level imports do

Both were executed rather than reasoned about. The SMTP transport has opened its
TLS and TCP sockets with `await import("node:tls" | "node:net")` since long before
any of this work, through the same text the emitted list was already shipping, so
refusing the dynamic form would have forced one function of the domain to stay
behind in the monolith for a hazard that does not exist. The check now refuses
every external except a dynamic import of a builtin — still stricter than
`createServerBundleModuleSource`, which allows the static form too because
`format: "esm"` has no lowering to do. A dynamic import of a *package* stays
refused: it survives verbatim as well, and then finds no `node_modules`.

The narrowing is only safe while the static form is still refused, so the two are
tested as a pair against a skewed `dist/`: `import { randomUUID } from "node:crypto"`
and the same without the `node:` prefix are both build failures, and the honest
build is asserted to carry both `await import(…)` calls and no `require(`. The
mail module reaches the UUID generator through the Web Crypto global for this
reason, which is the one line of that domain that is not byte-identical to the
region it moved out of.

**A migrated module may not declare a top-level name the monolith also binds, and
the reason is `bin/`.** This is the second cost of the split above, and it was
found by shipping it rather than by reasoning about it.

`bin/sporades.js` is the whole of `src/` bundled by esbuild into one scope. Two
modules in that scope declaring the same top-level name is not an error — esbuild
renames one. So batch 2's mail module opening with

    const randomUUID = () => crypto.randomUUID();

collided with `server-runtime-source.ts`'s `import { randomUUID } from "node:crypto"`,
and inside `bin/` the *import* became `randomUUID2`. Every still-registered runtime
function then travelled into the emitted bundle as `fn.toString()` source text
saying `randomUUID2`, while the bundle's hand-written preamble still imported
`randomUUID`. The result is a free binding in the artifact that ships, and it is
invisible to everything that builds the bundle from `dist/` — which is every check
in `test/server-bundle-free-bindings.test.js`, because the suite imports from
`dist/` where no renaming has happened. Fourteen container tests failed with
`randomUUID2 is not defined` out of a running Capsule while that whole file stayed
green.

Two things follow, and the second matters more than the first. The mail module
writes `crypto.randomUUID()` at its four call sites rather than aliasing it, so the
collision does not exist. And the collision is now refused at its source rather
than its rename detected at its destination: a guard reads the top-level bindings
of every module in `MIGRATED_RUNTIME_MODULES` and of `server-runtime-source.js`,
and fails on any overlap other than the names the monolith imports *from* that
module — which are one binding and rename together. Replanting the original
`const randomUUID` fails it by name.

The general statement, for the batches that follow: **the emitted list makes the
monolith's top-level namespace shared with every migrated module**, because a
stringified function carries the names its own scope resolved rather than the
bindings. That is one more thing the emitted list costs, and it goes away with it.

**The walker census had to stop reading a list.** The census in
`test/database-adapter-engine-seam.test.js` flagged emitted runtime functions
whose source names comment or quote delimiters, and asserted the detected set
*equals* a written census. Moving the gate out of `SERVER_RUNTIME_SOURCE_FUNCTIONS`
made it invisible there, so the census would have gone quiet about the one
tokenizer while continuing to report success — the exact shape of failure ADR-0038
spends its methodology section on. It now reads the union of the emitted list and
**every function each migrated module declares, parsed out of that module's
compiled source text** — `MIGRATED_RUNTIME_MODULES` in that file, which every
batch of the migration extends. Reading a module's *exports* would have been the
easy version and the wrong one: privacy would have become a way to leave the
census, at the moment privacy became possible. `nestingBlockCommentEnd` is a
private helper and is a census entry, and a planted private walker in that module
was confirmed to fail the census rather than reasoned about.

**Extending that list is the load-bearing half, and the cost of forgetting it was
measured rather than argued.** A private `const`-arrow walker planted in
`log-index-guard`, spelled the way the pre-collapse walkers were spelled, fails
the census by name. With the plant still in the shipped module and only the
module's *entry* removed from the list, both walker guards pass. The failure has
no red anywhere: the subjects went away rather than started failing, which is why
a batch that migrates a domain and does not list it silently narrows every guard
that reads the emitted list. Each entry therefore carries its own floor and its
own sentinel function, so a module whose parse quietly returned nothing fails on
its own rather than being covered by another module's count.

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

It also does not claim the mechanism generalizes untested to every region. The
first version of this section said the mechanism was proven only for a module that
imports nothing, and named the boundary: give `transformSync` a module with an
import and it emits a `require(…)` into the IIFE, and the Capsule dies at boot
with "Cannot determine intended module format". **That prediction was correct and
has since been executed rather than left standing.** `log-index-guard` imports
this gate's tokenizer; `transformSync` over its compiled text emits
`require("./inspection-sql.js")`, which is why the carrier bundles now.

**The case that section named as untested — a migrated module importing something
outside the migrated set — was executed in batch 2 and is where the "any external"
rule was narrowed.** See the self-containment section above. The mechanism is now
proven for four modules: two that import nothing (`inspection-sql`, `mail-config`),
one that imports another migrated module (`log-index-guard`), and one that reaches
Node builtins through dynamic `import(…)` (`mail-runtime`). The case still untested
is a migrated module importing a *package*, which the metafile check turns into a
build error rather than a boot failure and which nothing in this runtime has yet
wanted to do.

A region whose functions are called from the still-monolithic runtime will keep
needing exports for those names. `skipSqlTrivia` and `readSqlQuotedIdentifier`
were that here, because the internal log-index table guard lexes SQL with this
gate's tokenizer — a coupling invisible while both lived in one file. They still
are exports, but the consumer is now `log-index-guard.ts` rather than 13,700 lines
of unrelated domains, and the guard is a module beside this one rather than inside
it because ADR-0038 draws the gate/guard line and concealing an internal table is
not one of the gate's rules. **The transferable half is that the coupling was
found by grepping for callers before drawing the boundary, not after** — which is
what every remaining batch should do.

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

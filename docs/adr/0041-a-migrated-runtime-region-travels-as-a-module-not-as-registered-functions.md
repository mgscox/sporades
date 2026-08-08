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

**Two migrated modules may share a private top-level name, and batch 4 is where
that first happened.** `jobs-runtime.ts` and `auth-runtime.ts` both open with
`const nodeCryptoModule = process.getBuiltinModule("node:crypto")`, so esbuild
renames one to `nodeCryptoModule2` — in `bin/sporades.js` and again inside the
carried IIFE. Checked rather than assumed: the generated bundle declares both names
and every use resolves to a declaration.

It is safe for the reason the monolith case is not. The rename hazard needs a
*stringified* function that references the renamed name, because only source text
carries names rather than bindings; a private module-scope name never leaves its
module's scope, so esbuild renames the declaration and its uses together. The
collision guard therefore compares migrated modules against `server-runtime-source.ts`
and deliberately not against each other.

What is *not* safe, and is worth naming because nothing above implies it: two
migrated modules **exporting** the same name. Those are destructured side by side at
the bundle's top level, which is a duplicate declaration and a load-time
`SyntaxError`. No guard tests for it directly; it is caught by parsing the built
bundle for duplicate top-level declarations, which is the check ticket 04 records as
missing and which batch 4 ran by hand at 534 top-level names and zero duplicates.
Batch 5 ran it again and reports 505 names and zero duplicates, against 510 for its
own base measured the same way — the two absolute figures are not comparable across
batches because the count depends on the Capsule source the bundle is built for, so
**a batch should measure its own base rather than compare against a number in this
paragraph.** The delta is the useful half: batch 5's five missing names are exactly
the five declarations it made private (`createPreferencesError`,
`rotateSessionOnAdapter`, `moveSessionToUserOnAdapter`, `rotateSession`,
`moveSessionToUser`), the last two of which esbuild drops entirely because nothing
in the repository references them. Diffing the two name *sets* is what makes that
reviewable; a count alone would have said "five fewer" and not which five.

Batch 7 measured its own base at 501 and 470 after, zero duplicates on both sides and no
name appearing that was not there before; the 31 that went are exactly the 31 declarations
`acl-runtime.ts` made private. Its base of 501 happens to equal batch 6's *after* figure,
which is a coincidence of two probes counting the same tree rather than evidence of
anything — measure your own base regardless.

Batch 6 measured its own base at 528 top-level names and zero duplicates, and 501
after, with zero duplicates and **no name appearing that was not there before**. The
27 that went are exactly the 27 declarations it made private — the S3 request path
bar the three pure functions the skew probe calls, the File path resolvers, the
upload path lock and the two data migrations. That the 27 line up name for name with
the module's private set is the reviewable part; that 528 and 501 are neither 534,
505 nor 510 is why the paragraph above says to measure rather than compare.

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

**Batch 9 is the last domain, and it is the batch where an accurate-looking estimate was
wrong in both directions at once by sixteen and eight.** The Database adapters and dialect
were estimated at ~55 and are 59 declarations, which reads like the sequence's first
accurate estimate and is not: the name sweep collects 51, eight of which are not this
domain's, and misses sixteen that are. The errors nearly cancel. That is batch 6's warning
about a cancelling estimate, arriving on the batch with the largest domain.

**Both passes were run and they overlap on nothing.** The reverse-graph pass flagged ten
seeds with no in-domain caller and — applying batch 7's refinement that the question flags
entry points and foreigners alike — reading the bodies kept two and rejected eight.
`sqliteTypeForFieldKind` is the sharpest of the eight: it is named for the SQLite dialect,
sits nowhere near it, and populates the `sqliteType` field on a Capsule schema that the
dialect's `columnType` entry *later reads*. Layout is not membership, a name is not
membership, and here neither was proximity to the thing that consumes your output.

**The content sweep needed sharpening before it answered anything, and that is the finding
to carry forward.** Batch 8 recommended one and was right to, but its own form of the
question — which declarations touch SQL text, `prepare`, `exec`, `all`, `get` — collects 54
extra declarations on this batch and nearly all of them are false. *Every* domain in this
runtime emits SQL through these adapters, so on the layer everything else is built on,
"touches the subject matter" selects consumers rather than members. The question that
answers is narrower: which declarations have what only a *member* has — a dialect seam entry
by name, a statement primitive being **defined** rather than called, engine wire bytes, an
engine-specific error string. Sharpened that way it took the sixteen and nothing else, thirteen
of which are the shared method set's own bodies hoisted out of its object literal. So the
transferable rule is batch 8's plus one clause: **a content sweep must be written against
what distinguishes the layer from its callers, and on a bottom layer that is not the
vocabulary its callers use.**

**Every blocker sorted, and none was the composition core's — the first time since batch 4.**
Closing the domain's graph left nine names outside it. `createAnonymousAuthTables` went home
to `auth-runtime.ts` (batch 5's case), the value codec's writing half and `invalidReferenceError`
went to modules that already existed for their subject, and the Log index's storage became
`log-index-storage.ts`. All 59 declarations moved, against batch 4's 34 of 51 and batch 8's
32 of 33.

**The Log index's storage is a domain the ticket's nine batches never named**, and it is worth
recording because it is the one case the sequence's scoping missed rather than mis-sized.
Batch 1 was the log-index *guard* — four functions that conceal the table from `sporades db
query` — and nothing was ever scoped to the index itself. It surfaced as batch 9's blocker
because the only thing in the repository that calls it is the shared adapter method set. Nine
declarations, extracted on batch 6's third-answer rule. The platform log's sink did *not* go
with it and the seam is the adapter itself: `createRuntimeLogSink` reaches the index through
`database.insertLogIndexEvent(…)`, an adapter method resolved at run time rather than a module
binding, so that half cost this batch nothing and remains for ticket 05 to place.

**The pattern under three of the four blockers is one the migration kept finding rather than
one batch 9 drew.** A domain's table bootstrap belongs to that domain and the adapter delegates
to it: `ensureFileStorage()` and `ensureUserPreferencesStorage()` already crossed a module
boundary because batches 6 and 5 moved those tables, and `ensureAuthStorage()` and
`ensureLogStorage()` now do too. The adapter module owns no domain's tables and emits every
domain's SQL.

**Batch 9's differential limb is the third distinct shape of "what a refusal travels on", and
the emptiest.** Batch 3's denial record and batch 7's ACL refusal hung on a thrown error;
batch 8's `prepareHttpSecurity` answered a boolean identical across allowed and refused. Here
*almost nothing returns its own answer at all*: a dialect's catalog entries build a query and
hand it to an adapter, and every one of the seventy-odd shared method bodies builds a statement
and hands it to `this.prepare(…)`. Measured over the limb's 41 method cases, the return values
take **11 distinct values and are byte-identical between SQLite and Postgres** — a limb
comparing them could not have told the two engines apart at all, while a carried copy queried
`pg_catalog`, dropped the filter that hides SQLite's internals, emitted `INSERT OR REPLACE`
where Postgres needs `ON CONFLICT`, or dropped `updateAppRow`'s `ownerId` predicate. Driven
through a recorder the same cases take **39 distinct statement blocks and do differ by engine**.
The limb costs **0.311 ms** per bundle build against batch 8's 0.047, batch 7's 0.13 and batch
6's 0.07, and it reads no clock and does no I/O — asserted by comparing two runs byte for byte
rather than by inspection.

Two residuals are stated rather than left to be found. Parameter *values* are deliberately not
recorded, because some bodies bind a fresh UUID or a clock read and recording them would make
two honest copies disagree on every build; the parameter *count* is kept. And `probedAnswer`
drops `hint`, which for this domain's refusals is the whole actionable half — `commandError`
leaves `code` null, so an incomplete-seam refusal would compare on its message alone. A local
`dialectProbedAnswer` adds it, as `authProbedAnswer` and the ACL one add what theirs travel on.

**Two of batch 9's ten skews did not fail, and both were the probe's fault.** The Date fixture
was written in canonical ISO form, so a `normalizeDateValue` that had stopped normalizing
returned the identical string; and the marker fixture's bracketed text was identifier-shaped, so
widening the substitution's bound changed no answer. Neither gap was visible on any honest build.
That is the third batch running to find a limb blind to exactly what its own sabotage changes,
and the first to find it in a *fixture* rather than in what the limb captured — **a probe whose
input already satisfies the rule cannot see the rule being removed.**

**Batch 9's counterfactual is the eighth confirmation, and the first that comes out differently.**
A private `const`-arrow SQL walker planted in `database-runtime.ts` and called from
`quoteIdentifier` fails the census by name, with the plant reaching the emitted Capsule bundle —
two occurrences, confirmed by building it. With the plant still shipping and only the module's
entry removed from `MIGRATED_RUNTIME_MODULES` in the seam test, **the plant becomes invisible to
the census, exactly as in batches 1–8 — but the census still fails**, because three of this
module's functions (`postgresInterpolate`, `splitSqlStatements`,
`createSharedDatabaseAdapterMethods`) are already named in the written census and disappear with
it. So the guard goes red for the wrong reason and says nothing about the plant. That is luck
rather than protection: it happens only because this domain owns census entries, which
`acl-runtime`, `http-runtime` and `log-index-storage` do not. The thing that actually protects an
unlisted module is its `atLeast` floor and sentinel, and those are not consulted at all when the
entry is absent. **A batch that migrates a domain and does not list it still silently narrows
every guard that reads the emitted list.**

Batch 9 measured its own base at 453 top-level names in the emitted bundle and 410 after, zero
duplicates on both sides. The 46 that went are exactly the 46 declarations it made private — the
38 in `database-runtime.js`, `backfillLogIndexSequences` and `chainSchemaOperation` in
`log-index-storage.js`, the four auth storage migrations, and `toSqlNumber` and `dateValueError`
in the codec. **Three names appeared that were not there before**, which no batch before this one
saw: `listDatabaseTables`, `dumpDatabase` and `runReadOnlyQuery` were `export`s of
`server-runtime-source.ts` that were never entries in `SERVER_RUNTIME_SOURCE_FUNCTIONS` — the CLI
imports them directly — so they never reached the emitted bundle at all. Carried as module text
they do. It is the same fact the walker census recorded when `simulateLocalIdentitySession`
appeared in it: **the emitted list was never the whole runtime**, so migrating a domain can add to
the shipped artifact as well as take away.

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

Sixteen modules are carried as of batch 9, `log-index-storage` and `database-runtime` being
the fifteenth and sixteenth. The second is the first to import from *nine* other migrated
modules, and the first to need three of ADR-0042's four routes to a Node builtin in one
file. Nothing in the set imports it, so unlike batch 8's pair it sits on no cycle.

Fourteen modules are carried as of batch 8, `http-runtime` being the fourteenth. It is the
first to sit on a *cycle* — it imports `auth-runtime` and `auth-runtime` imports it — which
the carrier resolves for the same reason it resolves every other edge in the set, and which
is safe for the reason recorded in the batch 8 section below. Like `acl-runtime` it reaches
no Node builtin, so ADR-0042's accessor does not appear in it either.

Thirteen modules are carried as of batch 7 — `runtime-log-policy`, `stored-row-decoding`
and `acl-runtime` are the eleventh to thirteenth. `acl-runtime` is the first to import
from *six* other migrated modules, which the carrier resolves without comment for the
reason bundling the whole set together was already forced. It reaches no Node builtin, so
ADR-0042's accessor does not appear in it.

Ten modules are carried as of batch 6, `maybe-promise` and `file-storage-runtime`
being the ninth and tenth. The storage module is the first to combine every route a
carried module has to something outside itself in one file: a dynamic import of a
builtin, a *conditional* dynamic import of two builtins, and the
`process.getBuiltinModule` accessor, alongside an ordinary import of another
migrated module. All four pass the metafile check, and the honest build is asserted
to carry `process.getBuiltinModule("node:crypto")` and no `require(`.

**The case that section named as untested — a migrated module importing something
outside the migrated set — was executed in batch 2 and is where the "any external"
rule was narrowed.** See the self-containment section above. The mechanism is now
proven for eight modules: two that import nothing (`inspection-sql`, `mail-config`),
four that import another migrated module (`log-index-guard`, `auth-runtime`,
`jobs-runtime`, `user-preferences-runtime`), one that reaches Node builtins through
dynamic `import(…)` (`mail-runtime`), and one that exists only so others can import
it (`runtime-errors`). `jobs-runtime` is the first to import *two* other migrated
modules — `runtime-errors` for `commandError` and `assertJsonCompatible`, and
`auth-runtime` for `PASSWORD_RESET_MAIL_JOB` and `privilegedAuthUserId` — which the
carrier resolves without comment, because bundling the whole migrated set together
was already forced for the reason recorded above. The case still untested is a
migrated module importing a *package*, which the metafile check turns into a build
error rather than a boot failure and which nothing in this runtime has yet wanted
to do.

**Batch 4 is the first batch whose domain did not detach, and that is a finding
rather than a shortfall.** Jobs and schedules are 51 declarations and 34 of them
moved; the other seventeen are held by `createMutationContext`, which is the point
where every domain's API is composed into one handler context and which ticket 04
names as what `server-runtime-source.ts` retains, and by `hasPrivilegedDbAccess`,
which is batch 6's. So the queue's worker, its enqueue path and the Schedule
reconciler are still in the monolith while the storage, the cron machinery, the
cursors and the inspection are not.

The consequence worth recording is for the sequencing rather than for this batch:
**`enqueueRuntimeJob` did not travel, so batch 3's `sendEmailPasswordResetLink` is
still blocked.** ADR-0041's account of the auth batch names `enqueueRuntimeJob` as
one of four things outside the auth closure and batch 4 as its owner. Batch 4 owns
it and could not move it, because it reaches `scheduleCurrentUserJobWorker` and
through it `runCurrentUserJobWorker`, which builds a context. A blocker naming a
later batch is therefore not a promise that the later batch clears it — the chain
has to be closed at the end that holds it, and here that end is the composition
core rather than any domain on the list.

**Batch 5 is the other half of that finding, and it is the reassuring half.** User
preferences is six declarations and all six moved, and the seven auth functions
they were holding moved with them. Batch 4's rule stands — a blocker naming a
later batch is not a *promise* — but the converse is not true either: this blocker
did name a batch, that batch did clear it, and it cleared more than the ticket
predicted. The ticket said six auth stragglers and the reference graph says seven
(`rotateSessionOnAdapter`, `moveSessionToUserOnAdapter`, `signInWithEmail`,
`signUpWithEmail`, `linkProviderIdentity`, `rotateSession`, `moveSessionToUser`),
which is also the number batch 3's own arithmetic implies. **The way to tell the
two cases apart is cheap and should be run before any batch is scoped**: close the
blocked functions' reference graph and see whether what holds them is a domain on
the list or the composition core. `enqueueRuntimeJob` reached `createMutationContext`
and could not move; `rotateSessionOnAdapter` reached nothing but
`migrateAnonymousPreferences` and `auth-runtime` itself, and moved.

The auth domain is finished apart from the seven functions in the HTTP layer and
`sendEmailPasswordResetLink`, and that last one is worth restating for batches 6–9:
**it is not waiting on a batch at all.** It reaches `enqueueRuntimeJob`, which needs
the composition core, so it is ticket 05's or a composition change's — not batch 8's.

**Batch 6 is where the count was wrong in both directions at once, and where the
test for "domain or composition core" needed a third answer.** File and object
storage was estimated at ~54 by name sweep and is 51 declarations plus one type
alias, which looks like the estimate landing. It is not: three of the functions the
sweep collects are not the domain's, and the graph found them by a question no
sweep asks. `runSchemaExecIgnoringDuplicateColumn`, `isDuplicateColumnError` and
`chainSchemaOperation` sit *inside* the file region, between two file helpers each,
and **no file function calls any of them** — their only callers are the SQLite
dialect's `addMissingColumn` and the log index's table creation. Layout is not
membership. The cheap check that finds this is "which members of the seed set have
no in-domain caller", and it should be run on every batch, because it costs one
pass over the reverse graph and it is the only thing that separates a name from a
neighbour.

**The third answer is "neither — extract it".** Batch 4's rule sorted a blocker
into a domain or the composition core. Storage's graph left four things outside it
and one fits neither box: `thenIfPromise` and `chainMaybePromise`, the sync/async
bridge that lets one adapter method body serve a synchronous SQLite engine and an
asynchronous Postgres or libSQL one. Six domains call them — adapters, ACL,
logging, schema migration, the auth tables and storage — and none owns them. Left
behind they held `singleLiveFileRowByPath` and `createFileStorageTables`, and
through the first `resolveLiveFileReference`, `createPendingFileUpload`, both URL
paths and `deletePrivateFile`: the whole upload lifecycle held by a four-line
utility. So batch 6 did what batch 3 did with `commandError` and made
`maybe-promise.ts` — the second non-domain module, and the second time this
sequence has needed one. **The test to add to batch 4's is: if the blocker belongs
to no domain, it is not a later batch's and never will be, and extracting it is
cheaper than cutting a domain in half.**

`runtime-errors.ts` was not the home for them, and that is a judgement worth
recording rather than leaving to look arbitrary. `assertJsonCompatible` was
admitted there in batch 4 on a cohesion argument — it does nothing but throw an
error factory that already lived in the file. Nothing about chaining a
maybe-promise is cohesive with errors, and the cost of a file whose name stops
describing its contents is paid by every later reader rather than by the batch
that saved the ceremony.

**Batch 7 is where the third answer was needed twice in one batch, and where the last
preamble constant left.** ACL and privileged audit was estimated at ~61 by name sweep; the
sweep collects 63 and the graph disagrees with that in both directions again. One of the
63 is not the domain's — `runMutationHookAndDrainPendingAclWrites` has no in-domain caller,
its body is `runMutationHook` in a `try` with `drainPendingAclWrites` in the `finally`, and
it sits at the mutation layer beside the function it wraps. Three more could not travel:
`createPrivilegedHandlerContext`, `createContextPrivilegedApi` and `createPrivilegedJobApi`,
held by `createContextHolder`, `createEndpointDatabaseApi` and `createCurrentUserJobApi`.
That is batch 4's case rather than batch 5's — a privileged handler context *is* the point
where every domain's API is composed onto one object — so the chain closes at ticket 05 and
at no batch on the list. Fifty-nine of 62 moved.

Three blockers belonged to no batch, and two modules came out of them:
`runtime-log-policy.ts` for `isSensitiveLogKey` and `logIndexLimit`, and
`stored-row-decoding.ts` for `deserializeRow` and its near-twin `deserializeFieldValue`.
What each held is the argument for extracting rather than shrugging: `isSensitiveLogKey`
held the ACL denial record and through it all three enforcement entry points,
`deserializeRow` held `createAclHelpers` and therefore `ACL_HELPER_STATE`'s only writer, and
`logIndexLimit` held the privileged-audit reindex after a rollback. Nine lines and thirteen
would otherwise have kept the domain's heart in the monolith and the last constant in the
preamble. Two modules rather than one because they are two subjects; the pair
`deserializeRow`/`deserializeFieldValue` travels together because they are one rule written
at two granularities — the emitted list is why there are two copies at all — and splitting
them across a boundary would have put the copies further apart than the single file had.

**The last four preamble constants left in this batch, and the preamble now serializes
nothing.** `PRIVILEGED_AUDIT_SCHEMA`, `PRIVILEGED_AUDIT_ACTOR_KINDS`,
`PRIVILEGED_AUDIT_OUTCOMES` and `ACL_HELPER_STATE` are declarations inside `acl-runtime.js`,
and they left `runtimeConstants` in the commit that moved them for the reason batch 3's
twelve did. The empty list is kept rather than deleted: the emitted list still ships, so a
constant added to the monolith before ticket 05 would still need an entry.

**`ACL_HELPER_STATE`'s Symbol identity stopped being an argument and became a measurement.**
Issue 16 established that the preamble's reconstruction was safe because the key has one
writer (`createAclHelpers`) and one reader (`aclRuleTouchedAsyncHelperRead`), both of which
travelled into the bundle and resolved the preamble's single declaration. Carried as a module
declaration there is one `Symbol("sporades.aclHelperState")` expression in each bundle rather
than a declaration and a reconstruction — the property the module-graph bundle already had.
Both counts are asserted, in both bundles, along with the absence of a preamble copy beside
the declaration.

The identity itself is now executed on every bundle build rather than reasoned about. The
differential's ACL write limb drives a *synchronous* rule whose `ctx.acl.db.get()` returns a
thenable: `markAsyncAclHelperRead` writes `touchedAsyncRead` through the Symbol and
`aclRuleTouchedAsyncHelperRead` reads it back through the Symbol, and the write must be
refused. Executed rather than asserted — a skewed `dist/` in which the reader mints a Symbol
of its own answers `{"returned":"written"}` where the honest copy throws `DENIED`. **It is
the only skew in that test that fails open**, which is why it is the first case listed.

**Batch 7's counterfactual is the sixth confirmation that both walker guards go green when a
module is carried and not listed.** A private `const`-arrow SQL walker planted in
`acl-runtime.ts` fails the census by name and fails the terminator-spelling guard by name.
With the plant still in `dist/acl-runtime.js` *and* reaching the emitted Capsule bundle — two
occurrences, confirmed by building it — and only the module's entry removed from
`MIGRATED_RUNTIME_MODULES` in the seam test, both guards pass with zero failures. Worth one
addition to the record: an *unreachable* plant is tree-shaken out of the carried block by
esbuild, so a counterfactual that only appends a dead function demonstrates less than it looks
like. Give the plant a caller before concluding the guard would have missed something that
ships.

**A differential limb must also capture what a refusal travels *on*, and batch 7 is the second
batch to find that the hard way.** The ACL write path reports a refusal by throwing, and
`createAclDeniedError` hangs the whole denial record on the error rather than returning it —
so `probedAnswer` dropped it, and with it `createAclDenialLogData`, `aclRuleDeclaredOperation`,
`aclRowLogSnapshot`, `aclVisibleFieldNames` and the only path from that limb into
`isSensitiveLogKey`. That is the same shape as batch 3's `authProbedAnswer` and it was closed
the same way. The `previous`/`next` arm of the row snapshot is reachable through nothing else:
a read refusal takes the other arm.

The other three blockers sorted normally. `writeNotFound` and
`writeJsonHttpResponse` are the HTTP layer's — their other consumer is
`routeRuntimeHealth` — so `handleFileHttpRoute` and `sendFileHttpResponse` stayed
behind for batch 8, which is a domain that has not run yet rather than the last
one. Two of fifty-three, against batch 4's seventeen of fifty-one.

**Batch 8 is where a name sweep was wrong in one direction only, and the direction it
was wrong in is the one no reverse pass finds.** HTTP and security policy was ticket
04's smallest remaining estimate at ~17; the domain is 32 declarations and two type
aliases. Every previous batch's error had a foreign function in it — a name the sweep
collected that belonged elsewhere — and batch 8 has none: the reverse-graph pass flagged
twelve seeds with no in-domain caller and every one of them is an entry point, so it
rejected nothing. The whole error is the other kind. Ten of this domain's declarations
answer to no HTTP-shaped name, and three of those ten are the ones that matter:
`writeEndpointResult`, `writeEndpointError` and `endpointResponseError` are named for the
endpoint layer and are pure HTTP response plumbing — a status code, a content type, an
error envelope, and the refusal of a malformed handler response — reaching nothing outside
the domain but `isPayloadTooLargeError`, which is also its.

**The pass that finds them is a content sweep, and it should be run beside the name sweep
rather than instead of it.** Asking which top-level declarations touch `writeHead`,
`response.end`, a `content-type` literal or an HTTP status code takes all three, takes
nothing this domain did not already have, and cost one pass. That is the transferable
half: batch 6's reverse-graph pass answers "is this seed really mine", and it cannot
answer "what did I fail to seed" — a function no sweep collected has no entry in the
reverse graph to flag. Two different questions, two different passes, and the second one
is what a low estimate looks like from the inside.

The reverse-graph pass still earned its keep on a batch where it rejected nothing. It is
what settled `checkRuntimeSqlite`, which by batch 6's own precedent looks like the
adapters' — batch 6 took `checkRuntimeFileStorage` because it probes storage, and this one
probes the database through `database.adapter.checkHealth()`. Its only caller is
`createRuntimeHealthResult` and its only other consumer in the repository is a test, so it
is the health route's limb rather than the adapters'. "Who calls this" separated a name
from a neighbour again, in the direction of keeping rather than rejecting.

**One function of the domain did not move, and it is the composition core's.**
`routeEndpoint` reaches `runEndpoint`, which reaches `createMutationContext`,
`createContextHolder` and `createEndpointDatabaseApi` by three independent two- and
three-step paths. Batch 4's case, so batch 9 does not clear it and ticket 05 does. The
three writers it calls moved anyway and it imports them back — the same trade batch 6 made
in the other direction when `writeNotFound` kept `handleFileHttpRoute` in the monolith.
Thirty-two of thirty-three, against batch 7's fifty-nine of sixty-two.

**All six of batch 3's blocked auth functions cleared, which is batch 5's case a second
time.** `routeSporadesAuth`, `beginOAuthSignIn`, `readOAuthCallbackParameters`,
`oauthFormContentTypeValid` and `resolvePasswordResetConfig` are riders in `auth-runtime.ts`
now. The sixth, `resolveOAuthRequestOrigin`, is in `http-runtime.ts` instead, and the
judgement is worth recording because the ticket named it as auth's: its body validates a
request origin against the CORS policy's `publicOrigin`, the `Host` header and the two
`X-Forwarded-*` headers, it references `normalizeOrigin`, `singleHttpHeader` and
`validatedRequestHost` and not one auth name, and its second caller is `createWebSocketHub`
rather than an OAuth path. **Layout is not membership, and neither is a name** — batch 6's
rule applied to a function's own body rather than to its neighbours. It leaves the monolith
either way, which is what "the blocker cleared" means; where it lands is a separate
question answered by reading it.

**Two migrated modules may import each other, and batch 8 is the first pair that does.**
`http-runtime.ts` imports `resolveAnonymousSession` from `auth-runtime.ts`, because the
private File route authenticates before it hands back a row; `auth-runtime.ts` imports four
HTTP primitives back for its riders. The cycle is a real domain edge rather than an artifact
of where the split was drawn, and it is safe for a reason worth stating rather than leaving
to be rediscovered: every binding across it is a hoisted `function` declaration, and every
use is inside a body that runs on a request rather than at module initialization, so neither
module reads a name of the other's before both are initialized. esbuild resolves it when it
bundles the migrated set into the carried IIFE and again when it builds `bin/`, and the
metafile check is unaffected because neither import is external to the set.

**A differential limb must capture what a refusal travels on — and batch 8 is the case
where the answer travels on nothing at all.** Batch 3's denial record and batch 7's ACL
refusal both hung on a thrown error that `probedAnswer` dropped. `prepareHttpSecurity`
throws nothing and returns nothing useful: it replaces `response.writeHead` with a wrapper
and answers a bare boolean saying only whether it already handled a CORS preflight.
Measured over the limb's twelve cases, that boolean takes **two distinct values**, and the
two preflight cases both answer `true` whether or not the origin was allowed — one writes
the `Access-Control-Allow-*` headers and the other writes none, and the return value is
identical. So a limb comparing the obvious thing would have compared `false` against
`false` ten times and `true` against `true` twice while a carried copy served a different
CSP, echoed an attacker's origin, stopped stripping `X-Powered-By`, or stopped escaping the
page connection token. The limb therefore drives the wrapper through a fake response that
records every `writeHead` argument. Seven skews were executed rather than reasoned about —
a loosened `object-src`, a dropped `frame-ancestors`, an always-true origin allow-list, a
sanitizer that stops stripping, a raised body limit, an unescaped connection token and a
missing export — and all seven are build errors, the last through the export-surface half
rather than the answers half. The limb costs **0.0465 ms** per bundle build against batch
6's 0.07 and batch 7's 0.13, and it reads no clock and does no I/O.

Batch 8 measured its own base at 470 top-level names in the emitted bundle and 453 after,
zero duplicates on both sides and no name appearing that was not there before. The 17 that
went are exactly the 17 declarations it made private — the fifteen in `http-runtime.js`
(the CSP construction, the origin and header predicates, the payload-limit error pair, the
health-result builder and the three low-level response writers) plus
`readOAuthCallbackParameters` and `oauthFormContentTypeValid`, which are private in
`auth-runtime.js`. As with every batch, the absolute figures are not comparable with the
paragraphs above; the name-set diff is the reviewable half.

**Batch 8's counterfactual is the seventh confirmation that both walker guards go green
when a module is carried and not listed.** A private `const`-arrow SQL walker planted in
`http-runtime.ts` and called from `serializeCspDirectives` fails the census by name. With
the plant still in `dist/http-runtime.js` *and* reaching the emitted Capsule bundle — two
occurrences, confirmed by building it, the caller being what keeps esbuild from tree-shaking
it — and only the module's entry removed from `MIGRATED_RUNTIME_MODULES` in the seam test,
both guards pass with zero failures.

**A module with no private function still needs a census sentinel, and an exported
one is the right answer.** Every batch from 1 to 5 used a private sentinel, and the
prose above makes that read like a rule. `maybe-promise` has three functions and
the monolith resolves all three, so it has no private name to use. `isPromiseLike`
is its sentinel for the reason `mail-config`'s `validateMailConfig` is: the other
two functions in the file are defined in terms of it, so no honest edit removes it.
The property the private sentinels were chosen for — evidence that privacy is not a
way out of the census — is already carried by six other entries.

**Two `randomUUID` routes now exist and one file should not use both.** ADR-0042
ranks the Web Crypto global above `process.getBuiltinModule` for `randomUUID`,
which is why the mail domain writes `crypto.randomUUID()`. Storage binds the
namespace anyway, for `createHmac` and `createHash` in the S3 signature, so its six
`randomUUID` call sites take the accessor as `auth-runtime.ts`'s four do. The
ranking is about which route to *reach for*, not about mixing two in one module
that already has one. Replanting batch 2's `const randomUUID = () => crypto.randomUUID()`
in this module fails the collision guard by name, which was executed rather than
assumed — and the guard stayed quiet for a replanted `const createHmac`, correctly,
because `s3Hmac` was the monolith's last consumer of that import and tsc had
already elided it.

**esbuild rewrites a conditional dynamic import into two analyzable ones.**
`s3Request` picks its transport with `await import(isHttps ? "node:https" : "node:http")`,
which looks like the unanalyzable form the carrier's metafile check cannot judge.
It is not: esbuild emits `await (isHttps ? import("node:https") : import("node:http"))`
and lists both as `kind: "dynamic-import"` externals, so the builtin allowance
covers them and the check passes unweakened. Measured on the built bundle, not
reasoned about.

**A differential limb must not serialize anything its own sabotage can make
unserializable.** Batch 5's probe first compared `[patch, probedAnswer(…)]` for the
preferences validator. Two of its patches are refused precisely *because* JSON
cannot carry them — a BigInt and a cycle — so with the JSON check sabotaged the
validator returned them, `JSON.stringify` threw, and the one skew the limb existed
to catch surfaced as `Do not know how to serialize a BigInt` out of the middle of a
bundle build rather than as a reported disagreement. The fix is to compare a
*verdict*: the label, and either the thrown code and message or a token saying
whether the returned value was the same reference. Identity rather than a bare
"admitted", so a copy that rebuilt or filtered the object is still a disagreement.
This was found by planting the missing check, which is the only reason it was found
at all — the limb was green, and would have stayed green, on every honest build.

**Batch 3 found the third way to reach a builtin, and it needed its own decision.**
The two routes above are asynchronous or global-only, and the auth domain's
credential path — `scryptSync`, `timingSafeEqual`, `createHash`, `randomBytes` — is
synchronous with no Web Crypto equivalent. `process.getBuiltinModule` resolves a
builtin synchronously off the `process` global, so esbuild sees no import and this
carrier's metafile check passes unweakened rather than being narrowed a second time.
ADR-0042 records it, including that it must be bound as a namespace rather than
destructured, for exactly the `bin/` renaming reason recorded above.

**The `bin/` collision rule was one case too narrow, and batch 3 is where that
showed.** As written above it exempts only the names the monolith imports *from* the
module being checked. Two modules that import the same name from the same third
module are also one binding with nothing to rename — `commandError` lives in
`runtime-errors.js` and both `auth-runtime.ts` and `server-runtime-source.ts` import
it — so the guard compares origins now, not just names. A *declaration* is still
refused whatever it is called, which is what keeps batch 2's `const randomUUID`
failing by name.

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

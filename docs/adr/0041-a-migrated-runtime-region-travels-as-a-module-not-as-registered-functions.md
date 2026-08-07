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
difference is not cosmetic. Concatenating would put the module's private helpers
at the bundle's top level beside five hundred other runtime functions, where a
name collision is a silently shadowed function declaration rather than an error —
so "private" would mean nothing at exactly the point it started to matter. Inside
the IIFE the private names are unreachable from the rest of the bundle.

The destructured names are **derived from the module's live exports**, not written
out beside it. A hand-kept list here would have the failure mode the constant
preamble had before it was serialized from the runtime source: a name spelled
wrong declares a binding that is `undefined` at runtime, and the free-binding
guard resolves it exactly as cleanly as a correct one. Derived, a name that is not
exported is never declared, so the guard sees the consumer's reference as
unresolved and fails the build. The guard's coverage of this region is preserved
rather than traded away.

## What this costs, stated rather than left to be found

**The emitted-list builder now reads a file.** It did not before —
concatenating source text resolves nothing, which is the property ADR-0040
records as the reason the `toString()` mechanism satisfied self-containment by
construction. `createServerBundleModuleSource` already had to locate its own
entry, and the walk to the package root that ADR-0040 explains is now shared
(`resolveSporadesPackageRoot`) rather than written twice. The failure mode is a
thrown build error naming the missing path, not a Capsule that starts and then
misbehaves; `dist/` is in `package.json`'s `files` and is committed.

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

## What is not decided here

This says nothing about *which* regions move or in what order, and nothing about
what happens when the emitted list is deleted. At that point the block carrier and
the reading of `dist/` go with it, because the module-graph bundle imports the
module directly and needs neither.

It also does not claim the mechanism generalizes untested to every region. It is
proven for one module that imports nothing. A region with imports of its own will
need `build` rather than `transformSync`, and a region whose functions are called
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

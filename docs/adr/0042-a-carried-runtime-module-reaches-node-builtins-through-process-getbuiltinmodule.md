# A carried runtime module reaches Node builtins through `process.getBuiltinModule`

## Status

Accepted. Extends ADR-0041, which decided how a migrated runtime region travels
into the emitted-list bundle, and narrows the rule it left in place for how such a
module may reach anything outside itself.

## The problem this exists for

ADR-0041 carries a migrated module into the generated Capsule bundle as one esbuild
IIFE, spliced into an ES module. `format: "iife"` lowers a *static* external import
to `__require("node:crypto")`, which is not defined in that ES module, so the
Capsule dies at boot rather than at build. The carrier therefore refuses every
external import, with one exception ADR-0041 added in batch 2: a *dynamic*
`import(…)` of a builtin, which esbuild emits verbatim and a container resolves
exactly as it resolves the bundle's own top-level imports. The mail transport opens
its TLS and TCP sockets that way.

So a carried module had two ways to reach a builtin — the Web Crypto global, which
is how mail gets `randomUUID`, and `await import(…)`. **Batch 3 is the first domain
for which both are closed.**

The auth domain's credential path is synchronous:

    hashEmailPassword          scryptSync, randomBytes
    verifyEmailPassword        scryptSync, timingSafeEqual
    hashPasswordResetVerifier  createHash
    readPasswordResetCode      timingSafeEqual
    passwordResetCodeParts     randomBytes
    createSessionToken         randomBytes

`await import("node:crypto")` is asynchronous, so taking that route means making
those six `async` and changing every caller. None of `scryptSync`,
`timingSafeEqual`, `createHash` or `randomBytes` has a synchronous Web Crypto
equivalent: `crypto.subtle.digest` is a promise, `subtle` has no scrypt at all, and
there is no constant-time comparison on the global. `randomUUID` is the exception
that made mail's route work, and it does not generalize.

Rewriting a password hash and a constant-time comparison onto a different API,
inside a refactor batch whose whole contract is that behaviour does not change, is
not an option that was seriously on the table.

## The decision

**A carried runtime module reaches a Node builtin through
`process.getBuiltinModule(id)`, bound once at module scope under a name the
monolith does not bind.**

    const nodeCryptoModule = process.getBuiltinModule("node:crypto");

`process` is a global in both places the module runs — `dist/auth-runtime.js`
loaded as an ES module, and the esbuild IIFE inside a deployed Capsule — so there
is no import for `format: "iife"` to lower. **The carrier's metafile check is not
relaxed for this module; it passes unweakened**, because esbuild sees no external
at all. That is the property that makes this preferable to widening the refusal
rule a second time.

The rule for a carried module is now, in order of preference:

1. A global that already provides what is needed (`crypto.randomUUID()`).
2. `process.getBuiltinModule(id)`, for a builtin needed *synchronously*.
3. `await import(id)`, for a builtin needed asynchronously (ADR-0041).
4. A static import — still refused, and still a build failure.

### Bound as a namespace, not destructured

    const { createHash, randomBytes, scryptSync, timingSafeEqual } = process.getBuiltinModule("node:crypto");

reads better and would have shipped a `ReferenceError`. `bin/sporades.js` is the
whole of `src/` in one esbuild scope, so those four top-level names collide with
`server-runtime-source.ts`'s `import … from "node:crypto"` and esbuild renames one
side; every still-registered runtime function then travels into the emitted bundle
as source text calling the renamed name while the preamble imports the original.
That is precisely the defect batch 2 shipped with `randomUUID`, recorded in
ADR-0041, and the guard in `test/server-bundle-free-bindings.test.js` refuses it.

So the seventeen call sites carry a `nodeCryptoModule.` prefix. Together with that
prefix, they are the only lines of the auth domain that are not byte-identical to
the region they moved out of.

## What this costs, stated rather than left to be found

**It raises the effective Node floor to 22.3.0.** `process.getBuiltinModule` landed
in Node 22.3.0; `package.json` declares `"node": ">=22"`. The declared range is
therefore wider than what the runtime now needs, on releases 22.0 through 22.2. The
shipped container is `node:22-alpine`, which has resolved well past 22.3 since June
2024, so this is a gap in the declared range rather than an observed one — and it
is stated here rather than silently closed, because narrowing `engines` is a
packaging decision with its own consequences and is not this batch's to make.

**It is a second way to reach a builtin, and two ways is more than one.** A reader
now has to know when to use which. That is why the four-step order above is written
out, and why the two forms are tested as a pair against a skewed `dist/`: the auth
module rewritten to use a static `import { scryptSync } from "node:crypto"` is a
build failure, and the honest build is asserted to contain
`process.getBuiltinModule("node:crypto")` and no `require(`.

**It is not a general escape hatch for packages.** `process.getBuiltinModule`
returns `undefined` for anything that is not a builtin, so a module that tried to
reach a dependency this way would fail at its first call rather than at build time
— which is worse than the metafile check it bypasses. Nothing in this runtime wants
to, and if something does, the metafile check is the mechanism to extend rather
than this one.

## What is not decided here

This says nothing about which regions migrate or in what order, and nothing about
what happens when the emitted list is deleted. At that point the carrier and the
whole `format: "iife"` constraint go with it, because the module-graph bundle
imports these modules directly and a static `import … from "node:crypto"` is
unremarkable there. **This ADR expires with the emitted list**, and the seventeen
prefixed call sites can go back to an ordinary import at that point.

It also did not claim the accessor was needed anywhere else yet, and named batches 4
to 8 as the ones that might find otherwise. **Batch 4 did.** `scheduledOccurrenceIdentity`
derives a Scheduled occurrence's idempotency key with `createHash("sha256")`, and it
is called from inside the transaction that claims the occurrence — synchronous, with
no Web Crypto equivalent that does not change its signature and every caller's. So
`jobs-runtime.ts` reaches the builtin the same way, at one call site, and the rule is
used twice rather than once.

**Batch 6 is the third, and it is the first module to need the accessor and have a
global available for part of what it reaches for.** `s3Hmac` and `s3Sha256Hex`
compute the AWS SigV4 signature `s3Request` builds before it opens a socket:
synchronous, inside a call chain that has no `await` to spare, and with no Web
Crypto equivalent for either `createHmac` or a synchronous `createHash`. That is
rule 2, as auth and jobs are. But the same module mints six UUIDs — a file id, an
upload id, a version, a bucket id and a health-probe file name — and `randomUUID`
is exactly the case rule 1 exists for, which is how the mail domain gets it.

**The four-step order above ranks the routes a module should reach for; it does not
require a module to use two.** `file-storage-runtime.ts` binds the namespace
regardless, so its six `randomUUID` call sites take the accessor, and the file has
one mechanism rather than two. That is what `auth-runtime.ts` already does at four
call sites, and this ADR now says so rather than leaving the two readings open.

The check that the ranking still matters: a module that needs *only* `randomUUID`
must take the global, because binding the namespace for one call would be reaching
for a heavier route than the work requires. Nothing in the runtime has that shape
except mail, which does take the global.

Two things that were properties of a single use are now properties of a pattern, and
both were checked rather than assumed. The accessor is a *namespace* binding in all three
modules for the `bin/` reason above — and because all three spell it
`nodeCryptoModule`, esbuild renames the second and third inside `bin/sporades.js`
and inside the carried IIFE. That is harmless where the monolith case is not, because a
private module-scope name never leaves its module and so its declaration and its uses
are renamed together; the generated bundle was confirmed to declare both names with
every use resolving. And the pairing that keeps the narrowing safe — the static form
still refused — is now tested against a skewed `dist/` for this domain as well as for
auth.

## Relationship to existing decisions

Extends ADR-0041, whose self-containment section this refines: the rule there is
"no external except a dynamic import of a builtin", and this adds a route that
produces no external for the check to judge. ADR-0040 is unchanged — a deployed
Capsule still resolves nothing at runtime that the image cannot supply, and a
builtin is exactly what the image supplies. ADR-0033's password-reset links and the
credential handling behind them are unchanged in substance; what moved is where the
declarations live.

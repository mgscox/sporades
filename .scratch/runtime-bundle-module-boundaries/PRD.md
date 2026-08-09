# Runtime Bundle Module Boundaries

## Problem

The generated Capsule server bundle is assembled by calling `Function.prototype.toString()`
on a flat list of 528 runtime functions and concatenating the source text. Everything
about the runtime's shape follows from that one decision:

- A runtime function **cannot call a helper** unless the helper is also in the emitted
  list, so shared logic is inlined and duplicated instead of factored.
- A runtime function **cannot close over a module constant**, so every constant it needs
  is re-declared in a hand-maintained bundle preamble.
- A name that fails to travel is a **`ReferenceError` in a deployed Capsule**, not a
  compile error — invisible to every test, because tests import the real module.
- The runtime **cannot be split into files at all**, because `toString()` captures a
  function body and not its imports.

The result is a single 14,148-line module holding at least ten unrelated domains — mail,
schedules, ACL, file and S3 storage, auth, jobs, HTTP, security policy, the database
adapters and the SQL inspection validator. It is 37% of all source in the repo. The rest
of the codebase is modular; this file is the exception, and the exception is forced by
the bundling mechanism rather than chosen.

## Why now

This is not a tidiness complaint. The constraint has already produced three tickets of
defect work and is actively blocking a fourth.

- The bundle-preamble constants were restated rather than derived, putting a second copy
  of several security thresholds — sign-in failure limits, password reset TTL bounds — one
  edit away from silently disagreeing with the runtime.
- A guard had to be written specifically to catch names that fail to reach the bundle,
  because the language cannot catch them.
- The read-only inspection validator went through five rounds of fixes and four
  independent reviews, each finding a real, execution-verified defect of the same family.
  Its root cause is duplication: there are two near-identical SQL skippers whose divergence
  is deliberate, security-critical, and recorded only in a prose comment. Round one changed
  both and destroyed the asymmetry the comment describes. Nothing could catch it, because
  the invariant lives in prose rather than in a type, a parameter or a test. Each round
  then fixed one walker and left its sibling.

The comment in the source states the cause plainly: helpers are written inline "because
the generated server bundle is assembled from the source text of the functions in
`SERVER_RUNTIME_SOURCE_FUNCTIONS`, so a helper this one called would have to travel with
it or become a `ReferenceError` in a deployed Capsule."

## Decision

Two independent lines of work.

**Remove the duplication that is causing defects now.** One tokenizer, with the dialect
differences as an explicit argument rather than as two functions that must be kept
deliberately unequal. This is correct design whatever happens to bundling, and it is what
unblocks the inspection-validator work.

**Remove the constraint that forced the duplication.** Build the bundle from a real module
graph with esbuild — already a direct dependency, already used for exactly this kind of
job elsewhere in the repo — and then move the runtime out of the monolith domain by
domain. Sequenced expand–contract: prove the new bundler works alongside the old path,
migrate in batches that keep CI green because the old path still exists, and delete the
emitted list, the preamble serialization and the free-binding guard only once no caller
remains.

The migrate batches run as a linear chain rather than in parallel. They all delete from
the same file and edit the same emitted list, so concurrent batches would conflict
continuously, and a shared integration branch would defer green to the end. Sequencing
them keeps every batch independently verifiable.

## Out of scope

The client-side bundle pipeline already builds with esbuild and is not part of this
problem. Widening the expand step to cover it would enlarge the surface over which
behavioural equivalence has to be proven, for no gain.

## Further notes

The expand step is deliberately a proof of equivalence rather than a swap. The
`toString()` approach may have an unstated reason behind it — a self-containment or
no-`node_modules` requirement for deployed Capsules. Establishing that a module-graph
bundle boots and behaves identically, while the old path still exists, is what surfaces
such a reason before anything depends on the answer.

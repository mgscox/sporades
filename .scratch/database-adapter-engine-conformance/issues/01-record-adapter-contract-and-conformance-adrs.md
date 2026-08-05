Status: ready-for-agent

# Record Adapter Contract And Conformance ADRs

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Write the two architecture decision records that this feature's remaining work
implements, so the conformance specification is built against a written contract
rather than an implied one.

The first ADR states what the Database adapter method set commits to: it is
engine-agnostic and defined once, a method may return either a plain value or a
Promise, and a method must never derive a value, a branch, or a guard from an
unresolved query result. It may return a query result directly for the caller to
await; it may not test, count, coerce, or read a property off that result without
resolving it first.

That ADR must also record why the obvious stronger rule was rejected. Requiring
every adapter method to return a Promise would make every adapter read
asynchronous, and ADR-0022's ACL context helpers fail closed for synchronous ACL
rules when a read is asynchronous — so async-first would break Capsules whose ACL
rules are written synchronously. A future reader must not reopen that option
without meeting the constraint.

The second ADR states that one behavioural specification, executed against every
Database adapter, is the verification contract for the boundary, and that
genuinely engine-specific mechanics stay in per-engine tests. It is the
executable form of the engine agnosticism ADR-0021 asserts in prose.

ADR-0021 is precedent for a forward-looking ADR written before the
implementation it describes.

## Acceptance criteria

- [ ] An ADR records that the Database adapter method set is engine-agnostic and defined once, with engine differences confined to statement primitives and connection behaviour.
- [ ] That ADR states the dual-mode return convention as deliberate, and states the resolve-before-deriving invariant explicitly enough to cite in review.
- [ ] That ADR records async-first as considered and rejected, naming the ACL fail-closed interaction as the blocking constraint.
- [ ] That ADR explains that it narrows rather than reverses the completed runtime-path-awaitable decision: that decision governs how call sites consume adapter methods, this one governs how adapter methods consume their own statement primitives.
- [ ] A second ADR records that one behavioural specification run against every adapter is the verification contract for the Database adapter boundary, and that engine mechanics remain in per-engine tests.
- [ ] Both ADRs follow the existing house style: a decision-stating title, prose paragraphs, `CONTEXT.md` vocabulary, and no status or consequences headings.
- [ ] ADR numbers are taken from the next free numbers at the time of writing rather than reserved in advance.
- [ ] Neither ADR contradicts ADR-0021, ADR-0022, or ADR-0026; any relationship to an existing ADR is stated in the text.

## Blocked by

- None — can start immediately.

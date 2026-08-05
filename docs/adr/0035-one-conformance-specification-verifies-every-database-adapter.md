# One conformance specification verifies every Database adapter

One behavioral specification, parameterized by a Database adapter factory and
executed once per engine, is the verification contract for the Database adapter
boundary. It is the executable form of the engine agnosticism ADR-0021 asserts
in prose and of the method contract recorded in ADR-0034: where those decisions
say behavior above the Database adapter does not depend on the selected engine,
this specification is how that claim is checked. Behavior that code above the
adapter depends on is defined in one place rather than implied by whichever
engine a test happened to use.

The specification asserts at the Database adapter boundary that ADR-0021
defines, driving real adapters against real storage rather than re-asserting the
same behavior at a higher runtime seam. Its coverage is the runtime-owned
surfaces reached through that boundary: app table reads and writes, reference
integrity, auth storage including Sessions, email credentials and Reset codes,
File metadata storage, system metadata, and the Log index.

Every assertion compares an observed value against an expected value. "Did not
throw" is not an assertion here, because the defects this specification exists
to catch did not throw — they returned plausible wrong values. For the same
reason every predicate is exercised on both sides: an existence check is run
against a present row and an absent one, and a count against a known non-zero
quantity, because a check that always answers `true` and a count that always
answers `0` each satisfy a single positive assertion. Coverage prioritizes the
methods that derive a value from a query result — existence checks, counts,
guards that suppress a row, and multi-step methods that branch on an
intermediate result — since that is the shape ADR-0034 constrains and the shape
that produced every known defect.

The specification runs against the SQLite adapter directly, against the libSQL
adapter through the in-process fake libSQL service, and against the Postgres
adapter when a Postgres URL is configured in the environment. At least two
engines must run in an ordinary `npm test` invocation with no external
infrastructure, so engine divergence is a local and CI test failure on the
commit that introduces it rather than a discovery in a Hosted Capsule.
Environment gating controls only whether the Postgres run happens; it never
changes what is asserted, because a gated engine that checks less is a place
where engines are quietly allowed to disagree.

Genuinely engine-specific mechanics stay out of the shared specification and
remain covered by the existing per-engine tests: connection lifecycle, SQL
dialect emission, and transaction session mechanics such as the libSQL baton.
The dividing line is that a per-engine test may assert how one engine works, but
may not be the only place a behavior that code above the Database adapter
depends on is asserted. That preserves ADR-0026's split, which already verifies
workflow-level Transaction boundaries above the adapter while leaving adapter
mechanics at the boundary.

This is also the control on the per-engine method overrides ADR-0034 describes.
Postgres and libSQL each replace a substantial part of the shared method set,
and an override is permitted to change the statement text a method emits but
not the answer the method gives. Reading an override cannot establish which of
those it did; running the same specification against it can. That matters most
for the await-shim overrides, which emit the same SQL as a shared body that
derives from an unresolved result: the shim and the body it shadows are exactly
the pair whose answers must be shown to agree, and the shared specification is
what shows it — including after the shim is removed in favour of a
promise-aware shared definition.

Adding a method to the Database adapter without adding it to the conformance
specification leaves the work incomplete. A new engine adapter is likewise built
against this specification rather than against a reading of the SQLite adapter,
so a partial adapter fails loudly and early. Nothing here changes `ctx.db`, the
Sporades DB API, or any Capsule authoring surface; this work is invisible to
Capsule code by design.
